# Role-Scoped External Access to the Reports API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current JWT-gated `/api/public/*` reporting router with a shared, revocable API key plus per-request, role-based data scoping, so a separate Next.js project can call it server-to-server and see only the rows its own role hierarchy permits.

**Architecture:** A new `ApiKey` Prisma model + `requireApiKey` middleware (SHA-256 hashed lookup, mirrors the existing `RefreshToken` pattern) replaces the old static-env-var `publicApiKey.ts`. A new `resolveRequesterScope` middleware resolves three trusted headers (`x-requester-email`, `x-scope-emails`, `x-scope`) into `req.scopeOwnerIds` (fail-closed: missing scope headers → self only). `publicController.ts`'s existing owner-filtering helpers (`resolveOwnerScope`, plus `getSummary`/`getFilters`'s inline owner-list derivation) intersect against `req.scopeOwnerIds` instead of validating against the full connected-owner list.

**Tech Stack:** Node.js/TypeScript, Express, Prisma 5.22.0 (PostgreSQL), `express-validator`, Jest + `ts-jest` (new — no test runner is currently wired up in this repo).

**Spec:** `backend/docs/superpowers/specs/2026-09-22-role-scoped-reports-api-design.md`

## Global Constraints

- One shared API key for the whole external project — no per-external-user keys, no `userId` relation on `ApiKey` (spec "Non-goals").
- `expiresAt` is stored on `ApiKey` but NOT enforced/required by default — no auto-expiry (spec §1).
- Scope resolution is fail-closed: forgetting to pass `x-scope-emails`/`x-scope` never grants broader access than "self" (spec §3, step 4).
- `x-requester-email` is required on every `/api/public/*` request; missing it is a 400, and an email that doesn't resolve to a connected owner is a 403 (spec "Error handling").
- Unrecognized entries in `x-scope-emails` are dropped silently (warn-logged), never rejected outright (spec §3, step 3 and "Error handling").
- 401 on a missing/invalid/revoked/expired API key is always the same generic message — never distinguish "revoked" from "never existed" (spec "Error handling").
- No write endpoints on `/api/public/*` (existing `publicRoutes.ts` convention, unchanged).
- Response shape of all 6 `/api/public/*` endpoints is unchanged (spec "Data flow", step 4) — only which rows are visible changes.

## Codebase notes (corrections to the spec's file/name assumptions)

- The JWT middleware file is `src/middlewares/auth.ts` (exports `authenticate`), not `authenticate.ts`.
- `publicRoutes.ts` currently chains `requirePublicApiKey` (no-op unless `PUBLIC_API_KEY` env is set) then `authenticate` (full JWT) on **every** route — it is not actually open today, contrary to `publicController.ts`'s stale doc comment at the top of the file.
- `pickOwner`/`pickOwners` (the "defensive filter" pattern the spec references) live in `src/controllers/publicController.ts:142-151`, not in `hubspotOwnersService.ts`.
- There is no existing test runner wired up (`jest`/`@types/jest` are installed but there's no `jest.config.*`, no `"test"` script, and zero `*.test.ts` files anywhere in the repo). Task 1 below sets this up from scratch using `ts-jest` (already TypeScript, no need for `ts-node`/babel), mocking `../config/prisma` directly rather than adding `supertest`/a real test DB.

---

### Task 1: Test infrastructure (jest + ts-jest)

**Files:**
- Create: `backend/jest.config.js`
- Create: `backend/tests/setupEnv.ts`
- Create: `backend/tests/sanity.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: `npm test` runs Jest against `tests/**/*.test.ts`; every later task's tests rely on this. `tests/setupEnv.ts` sets `process.env.JWT_SECRET` before any module import, since `src/config/env.ts:12-14` throws at import time if it's unset.

- [ ] **Step 1: Add `ts-jest` as a dev dependency and a `test` script**

Edit `backend/package.json`:
- In `"scripts"`, add `"test": "jest"` (after `"prisma:status"`).
- In `"devDependencies"`, add `"ts-jest": "^29.1.1"`.

- [ ] **Step 2: Install it**

Run: `npm install` (from `backend/`)
Expected: `ts-jest` appears in `node_modules`, `package-lock.json` updated.

- [ ] **Step 3: Create the Jest config**

Create `backend/jest.config.js`:

```js
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
};
```

- [ ] **Step 4: Create the shared test env setup**

Create `backend/tests/setupEnv.ts`:

```ts
// Runs before any test file (and before any module it imports) loads.
// src/config/env.ts throws at import time if JWT_SECRET is unset, and
// several services/controllers import it transitively.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
```

- [ ] **Step 5: Write a sanity test**

Create `backend/tests/sanity.test.ts`:

```ts
describe("jest setup", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run it**

Run: `npm test` (from `backend/`)
Expected: PASS, 1 test.

- [ ] **Step 7: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/jest.config.js backend/tests/setupEnv.ts backend/tests/sanity.test.ts
git commit -m "test: add jest + ts-jest test infrastructure"
```

---

### Task 2: `ApiKey` Prisma model + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260922130000_add_api_keys/migration.sql`

**Interfaces:**
- Produces: `prisma.apiKey.{create,findUnique,findMany,updateMany}` — used by Task 4 (`ApiKeyService`) and Task 6 (`requireApiKey` middleware).

- [ ] **Step 1: Add the model to the schema**

Edit `backend/prisma/schema.prisma`, adding this model after `OAuthState` (end of file), mirroring the existing `RefreshToken` hashed-token pattern (`schema.prisma:339-351`):

```prisma
// Shared, revocable credential for a trusted server-to-server caller (see
// docs/superpowers/specs/2026-09-22-role-scoped-reports-api-design.md). One
// row per issued key, not tied to a specific human — only the SHA-256 hash
// is stored, same pattern as RefreshToken above. expiresAt is stored but not
// enforced by default (no auto-expiry today; present so a future expiry
// policy needs no migration).
model ApiKey {
  id         String    @id @default(uuid())
  name       String
  keyHash    String    @unique @map("key_hash")
  keyPrefix  String    @map("key_prefix")
  revokedAt  DateTime? @map("revoked_at")
  lastUsedAt DateTime? @map("last_used_at")
  expiresAt  DateTime? @map("expires_at")
  createdAt  DateTime  @default(now()) @map("created_at")

  @@map("api_keys")
}
```

- [ ] **Step 2: Write the migration SQL**

This repo's migrations are hand-authored and checked in directly (see e.g. `prisma/migrations/20260703165059_add_refresh_and_reset_tokens/migration.sql`). Create `backend/prisma/migrations/20260922130000_add_api_keys/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Run: `npx prisma migrate dev` (from `backend/`, requires `DATABASE_URL` reachable)
Expected: Prisma detects the new migration folder, applies it, reports `Your database is now in sync with your schema.`

Run: `npx prisma generate`
Expected: `@prisma/client` regenerated with `prisma.apiKey.*` typed methods — required before Task 4/6's code compiles.

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260922130000_add_api_keys
git commit -m "feat: add ApiKey model and migration"
```

---

### Task 3: API key token generation utils

**Files:**
- Create: `backend/src/utils/apiKeyTokens.ts`
- Test: `backend/tests/utils/apiKeyTokens.test.ts`

**Interfaces:**
- Consumes: `generateOpaqueToken`, `hashToken` from `src/utils/tokens.ts` (existing — `generateOpaqueToken(): string` returns 64 hex chars from `crypto.randomBytes(32)`; `hashToken(token: string): string` returns a SHA-256 hex digest).
- Produces: `generateApiKey(): { rawKey: string; hash: string; prefix: string }`, `hashApiKey(rawKey: string): string` — used by Task 4 (`ApiKeyService.issue`) and Task 6 (`requireApiKey` middleware, via `hashApiKey`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/utils/apiKeyTokens.test.ts`:

```ts
import crypto from "crypto";
import { generateApiKey, hashApiKey } from "../../src/utils/apiKeyTokens";

describe("apiKeyTokens", () => {
  it("generates a key with the lnk_ prefix and a matching SHA-256 hash", () => {
    const { rawKey, hash, prefix } = generateApiKey();
    expect(rawKey.startsWith("lnk_")).toBe(true);
    expect(hash).toBe(crypto.createHash("sha256").update(rawKey).digest("hex"));
    expect(prefix).toBe(rawKey.slice(0, 12));
  });

  it("generates a different key on every call", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.rawKey).not.toBe(b.rawKey);
  });

  it("hashApiKey is deterministic for the same input", () => {
    const raw = "lnk_test";
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- apiKeyTokens`
Expected: FAIL — `Cannot find module '../../src/utils/apiKeyTokens'`.

- [ ] **Step 3: Implement it**

Create `backend/src/utils/apiKeyTokens.ts`:

```ts
// src/utils/apiKeyTokens.ts
import { generateOpaqueToken, hashToken } from "./tokens";

const KEY_PREFIX = "lnk_";
// How much of the raw key is stored back for masked display (e.g.
// "lnk_a1b2c3d4...") — enough to tell keys apart in a list, never enough to
// reconstruct the secret.
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  rawKey: string;
  hash: string;
  prefix: string;
}

/** Generate a new API key. Only `hash` is ever persisted; `rawKey` is shown once. */
export function generateApiKey(): GeneratedApiKey {
  const rawKey = `${KEY_PREFIX}${generateOpaqueToken()}`;
  return {
    rawKey,
    hash: hashApiKey(rawKey),
    prefix: rawKey.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/** SHA-256 hash of a raw API key, for lookup/comparison. */
export function hashApiKey(rawKey: string): string {
  return hashToken(rawKey);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- apiKeyTokens`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/apiKeyTokens.ts backend/tests/utils/apiKeyTokens.test.ts
git commit -m "feat: add API key token generation utils"
```

---

### Task 4: `ApiKeyService` (issue/list/revoke)

**Files:**
- Create: `backend/src/services/apiKeyService.ts`
- Test: `backend/tests/services/apiKeyService.test.ts`

**Interfaces:**
- Consumes: `generateApiKey()` from Task 3; `prisma.apiKey.{create,findMany,updateMany}` from Task 2.
- Produces: `ApiKeyService.issue(name: string): Promise<{ id: string; rawKey: string }>`, `ApiKeyService.list(): Promise<ApiKeySummary[]>`, `ApiKeyService.revoke(id: string): Promise<void>` — used by Task 5 (`apiKeyController.ts`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/services/apiKeyService.test.ts`:

```ts
jest.mock("../../src/config/prisma", () => ({
  __esModule: true,
  default: {
    apiKey: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import prisma from "../../src/config/prisma";
import { ApiKeyService } from "../../src/services/apiKeyService";

const mockedPrisma = prisma as unknown as {
  apiKey: {
    create: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
};

describe("ApiKeyService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("issue() stores only the hash and returns the raw key once", async () => {
    mockedPrisma.apiKey.create.mockResolvedValue({ id: "key-1" });

    const result = await ApiKeyService.issue("Next.js server");

    expect(result.id).toBe("key-1");
    expect(result.rawKey.startsWith("lnk_")).toBe(true);
    const createArgs = mockedPrisma.apiKey.create.mock.calls[0][0];
    expect(createArgs.data.name).toBe("Next.js server");
    expect(createArgs.data.keyHash).not.toBe(result.rawKey);
    expect(createArgs.data.keyPrefix).toBe(result.rawKey.slice(0, 12));
  });

  it("list() returns masked summaries ordered by creation date", async () => {
    mockedPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        name: "A",
        keyPrefix: "lnk_aaaa",
        revokedAt: null,
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
    ]);

    const result = await ApiKeyService.list();

    expect(result).toHaveLength(1);
    expect(mockedPrisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });

  it("revoke() sets revokedAt only on a currently-active key", async () => {
    mockedPrisma.apiKey.updateMany.mockResolvedValue({ count: 1 });

    await ApiKeyService.revoke("key-1");

    expect(mockedPrisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { id: "key-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apiKeyService`
Expected: FAIL — `Cannot find module '../../src/services/apiKeyService'`.

- [ ] **Step 3: Implement it**

Create `backend/src/services/apiKeyService.ts`:

```ts
// src/services/apiKeyService.ts
import prisma from "../config/prisma";
import { generateApiKey } from "../utils/apiKeyTokens";

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export class ApiKeyService {
  /** Issue a new key. Only its hash is stored; the raw value is returned once. */
  static async issue(name: string): Promise<{ id: string; rawKey: string }> {
    const { rawKey, hash, prefix } = generateApiKey();
    const record = await prisma.apiKey.create({
      data: { name, keyHash: hash, keyPrefix: prefix },
    });
    return { id: record.id, rawKey };
  }

  static async list(): Promise<ApiKeySummary[]> {
    return prisma.apiKey.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        revokedAt: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  /** Idempotent: revoking an already-revoked key is a no-op. */
  static async revoke(id: string): Promise<void> {
    await prisma.apiKey.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- apiKeyService`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/apiKeyService.ts backend/tests/services/apiKeyService.test.ts
git commit -m "feat: add ApiKeyService (issue/list/revoke)"
```

---

### Task 5: API key admin routes (`POST/GET/DELETE /api/auth/api-keys`)

**Files:**
- Create: `backend/src/controllers/apiKeyController.ts`
- Modify: `backend/src/routes/authRoutes.ts`

**Interfaces:**
- Consumes: `ApiKeyService.{issue,list,revoke}` from Task 4; existing `authenticate` middleware (`src/middlewares/auth.ts`); existing `validate` middleware (`src/middlewares/validateRequest.ts`).
- Produces: `POST /api/auth/api-keys` (body `{ name: string }`, gated by `authenticate`, returns `{ id, rawKey }` once), `GET /api/auth/api-keys` (masked list), `DELETE /api/auth/api-keys/:id` (revoke).

No dedicated unit test — these are thin pass-through controllers over the already-tested `ApiKeyService`, matching this codebase's existing pattern (no controller has its own test; see `authController.ts`). Covered by Task 13's manual verification.

- [ ] **Step 1: Write the controller**

Create `backend/src/controllers/apiKeyController.ts`:

```ts
import { Request, Response, NextFunction } from "express";
import { ApiKeyService } from "../services/apiKeyService";
import { successResponse } from "../utils/apiResponse";

// POST /api/auth/api-keys — issues a new key. Gated by `authenticate` (an
// existing logged-in user of THIS app); the raw key is returned exactly
// once and never retrievable again (same pattern as refresh tokens).
export const createApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { name } = req.body as { name: string };
    const result = await ApiKeyService.issue(name);
    successResponse(
      res,
      result,
      "API key created — store it now, it will not be shown again",
      201,
    );
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/api-keys — masked list (keyPrefix only, never the raw key).
export const listApiKeys = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await ApiKeyService.list();
    successResponse(res, result, "API keys retrieved");
  } catch (error) {
    next(error);
  }
};

// DELETE /api/auth/api-keys/:id — revoke (idempotent).
export const revokeApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await ApiKeyService.revoke(req.params.id);
    successResponse(res, null, "API key revoked");
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 2: Wire the routes**

Edit `backend/src/routes/authRoutes.ts` — add the import and three routes. Full resulting file:

```ts
import { authLimiter, refreshLimiter } from "../middlewares/rateLimiter";
import { Router } from "express";
import {
  register,
  login,
  logout,
  getProfile,
  refresh,
  forgotPassword,
  resetPassword,
} from "../controllers/authController";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../controllers/apiKeyController";
import { body } from "express-validator";
import { validate } from "../middlewares/validateRequest";
import { authenticate } from "../middlewares/auth";

const router = Router();

// POST /api/auth/register - Register new user with validation
router.post(
  "/register",
  authLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters")
      .matches(/[A-Z]/)
      .withMessage("Password must contain at least one uppercase letter")
      .matches(/[0-9]/)
      .withMessage("Password must contain at least one number")
      .matches(/[^A-Za-z0-9]/)
      .withMessage("Password must contain at least one special character"),
    body("name").optional().isString(),
    validate,
  ],
  register,
);

// POST /api/auth/login - Authenticate user and return JWT
router.post(
  "/login",
  authLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
    validate,
  ],
  login,
);

// POST /api/auth/refresh - Exchange a refresh token for a new token pair
router.post(
  "/refresh",
  refreshLimiter,
  [
    body("refreshToken")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("refreshToken is required"),
    validate,
  ],
  refresh,
);

// POST /api/auth/logout - Revoke the provided refresh token (no auth required
// so it works even after the access token has expired)
router.post("/logout", logout);

// POST /api/auth/forgot-password - Send a password-reset OTP to the email
router.post(
  "/forgot-password",
  authLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    validate,
  ],
  forgotPassword,
);

// POST /api/auth/reset-password - Reset password using the emailed OTP
router.post(
  "/reset-password",
  authLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("code")
      .isString()
      .trim()
      .matches(/^\d{6}$/)
      .withMessage("code must be a 6-digit number"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    validate,
  ],
  resetPassword,
);

// GET /api/auth/profile - Get authenticated user profile
router.get("/profile", authenticate, getProfile);

// POST /api/auth/api-keys - Issue a shared API key for an external caller
// (e.g. the Next.js reporting frontend). Self-service, gated by your own
// login (authenticate) — not by any external caller.
router.post(
  "/api-keys",
  authenticate,
  [
    body("name").isString().trim().notEmpty().withMessage("name is required"),
    validate,
  ],
  createApiKey,
);

// GET /api/auth/api-keys - List issued keys (masked)
router.get("/api-keys", authenticate, listApiKeys);

// DELETE /api/auth/api-keys/:id - Revoke a key
router.delete("/api-keys/:id", authenticate, revokeApiKey);

export default router;
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` (from `backend/`)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/controllers/apiKeyController.ts backend/src/routes/authRoutes.ts
git commit -m "feat: add API key admin routes"
```

---

### Task 6: `requireApiKey` middleware (replaces `publicApiKey.ts`)

**Files:**
- Create: `backend/src/middlewares/apiKey.ts`
- Test: `backend/tests/middlewares/apiKey.test.ts`
- Delete: `backend/src/middlewares/publicApiKey.ts`
- Modify: `backend/src/config/env.ts` (remove now-unused `PUBLIC_API_KEY`)
- Modify: `backend/src/types/index.ts` (add `PublicApiRequest`)

**Interfaces:**
- Consumes: `hashApiKey` from Task 3; `prisma.apiKey.{findUnique,update}` from Task 2.
- Produces: `requireApiKey(req: PublicApiRequest, res, next)`, attaches `req.apiKeyId: string` on success — used by Task 12 (`publicRoutes.ts`). `PublicApiRequest` type is also extended by Task 9 (`requesterScope.ts`).

- [ ] **Step 1: Add the shared request type**

Edit `backend/src/types/index.ts`, adding after the existing `AuthRequest` interface (line 35):

```ts
// Request shape for the /api/public/* router once requireApiKey and
// resolveRequesterScope have run. scopeOwnerIds is null for an unrestricted
// requester (x-scope: all) and undefined only if resolveRequesterScope
// hasn't run yet — publicController.ts's applyRequesterScope treats
// undefined as "deny everything" (fail-closed), not "allow everything".
export interface PublicApiRequest extends Request {
  apiKeyId?: string;
  requesterOwnerId?: string;
  scopeOwnerIds?: string[] | null;
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/middlewares/apiKey.test.ts`:

```ts
jest.mock("../../src/config/prisma", () => ({
  __esModule: true,
  default: {
    apiKey: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

import prisma from "../../src/config/prisma";
import { requireApiKey } from "../../src/middlewares/apiKey";
import { hashApiKey } from "../../src/utils/apiKeyTokens";

const mockedPrisma = prisma as unknown as {
  apiKey: { findUnique: jest.Mock; update: jest.Mock };
};

const buildReq = (headers: Record<string, string>) => ({ headers }) as any;
const res = {} as any;

describe("requireApiKey", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.apiKey.update.mockResolvedValue({});
  });

  it("rejects a request with no x-api-key header", async () => {
    const next = jest.fn();
    await requireApiKey(buildReq({}), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("rejects an unknown key", async () => {
    mockedPrisma.apiKey.findUnique.mockResolvedValue(null);
    const next = jest.fn();
    await requireApiKey(buildReq({ "x-api-key": "lnk_bad" }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("rejects a revoked key", async () => {
    mockedPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1",
      revokedAt: new Date(),
      expiresAt: null,
    });
    const next = jest.fn();
    await requireApiKey(buildReq({ "x-api-key": "lnk_revoked" }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("rejects an expired key", async () => {
    mockedPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1",
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    const next = jest.fn();
    await requireApiKey(buildReq({ "x-api-key": "lnk_expired" }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("accepts a valid key, attaches apiKeyId, and touches lastUsedAt", async () => {
    mockedPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1",
      revokedAt: null,
      expiresAt: null,
    });
    const req = buildReq({ "x-api-key": "lnk_good" });
    const next = jest.fn();
    await requireApiKey(req, res, next);
    expect(req.apiKeyId).toBe("k1");
    expect(next).toHaveBeenCalledWith();
    expect(mockedPrisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: hashApiKey("lnk_good") },
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- middlewares/apiKey`
Expected: FAIL — `Cannot find module '../../src/middlewares/apiKey'`.

- [ ] **Step 4: Implement the middleware**

Create `backend/src/middlewares/apiKey.ts`:

```ts
import { Response, NextFunction } from "express";
import { hashApiKey } from "../utils/apiKeyTokens";
import prisma from "../config/prisma";
import { UnauthorizedError } from "../errors/AppError";
import { PublicApiRequest } from "../types";
import logger from "../utils/logger";

// Trusted-caller gate for the /api/public/* router. Replaces the old
// static-env-var requirePublicApiKey (single shared secret, no revocation).
// Looks up the SHA-256 hash of `x-api-key` against the ApiKey table — same
// hashed-lookup pattern as TokenService's refresh tokens. Never distinguishes
// "revoked"/"expired"/"never existed" in the response (see spec's Error
// handling section) — all three produce the same generic 401.
export const requireApiKey = async (
  req: PublicApiRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const headerKey = req.headers["x-api-key"];
  const provided = Array.isArray(headerKey) ? headerKey[0] : headerKey;

  if (!provided) {
    return next(new UnauthorizedError("Invalid or missing API key"));
  }

  try {
    const record = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(provided) },
    });

    const expired = !!record?.expiresAt && record.expiresAt.getTime() < Date.now();
    if (!record || record.revokedAt || expired) {
      return next(new UnauthorizedError("Invalid or missing API key"));
    }

    req.apiKeyId = record.id;

    // Fire-and-forget — never blocks the request on a write.
    prisma.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch((err: any) =>
        logger.warn("Failed to update apiKey lastUsedAt", { error: err?.message }),
      );

    next();
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- middlewares/apiKey`
Expected: PASS, 5 tests.

- [ ] **Step 6: Delete the old middleware and its env var**

Delete `backend/src/middlewares/publicApiKey.ts`.

Edit `backend/src/config/env.ts`, removing lines 53-56:

```ts
// Optional shared secret for the unauthenticated /api/public/* endpoints.
// Leave EMPTY to keep them fully open (current behaviour). Set it to require
// `x-api-key: <key>` (or `Authorization: Bearer <key>`) on those routes.
export const PUBLIC_API_KEY = process.env.PUBLIC_API_KEY || "";
```

(No other file references `PUBLIC_API_KEY` after Task 12 rewires `publicRoutes.ts` — confirm with `grep -r PUBLIC_API_KEY backend/src` returning nothing once Task 12 is done.)

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit` (from `backend/`)
Expected: no errors (note: `publicRoutes.ts` still imports the now-deleted `publicApiKey.ts` until Task 12 — if this step is run before Task 12, that import will fail; it's fine to defer this exact type-check to the end of Task 12).

- [ ] **Step 8: Commit**

```bash
git add backend/src/middlewares/apiKey.ts backend/tests/middlewares/apiKey.test.ts backend/src/types/index.ts backend/src/config/env.ts
git rm backend/src/middlewares/publicApiKey.ts
git commit -m "feat: add requireApiKey middleware, remove static publicApiKey"
```

---

### Task 7: `getConnectedOwnerByEmail` (extend `hubspotOwnersService.ts`)

**Files:**
- Modify: `backend/src/services/hubspotOwnersService.ts`
- Test: `backend/tests/services/hubspotOwnersService.test.ts`

**Interfaces:**
- Produces: `getConnectedOwnerByEmail(email: string): Promise<ConnectedOwner | undefined>` (case-insensitive exact match) — used by Task 9 (`requesterScope.ts`). `ConnectedOwner` gains an `email: string | null` field.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/services/hubspotOwnersService.test.ts`:

```ts
describe("hubspotOwnersService — getConnectedOwnerByEmail", () => {
  const OWNERS = [
    { id: "1", name: "Alice", hubspotOwnerId: "ho-1", email: "alice@example.com" },
    { id: "2", name: "Bob", hubspotOwnerId: "ho-2", email: "bob@example.com" },
  ];

  beforeEach(() => {
    jest.resetModules();
  });

  // Fresh module instance per test (the service caches owners at module
  // scope), with its dependencies mocked before it's required.
  const loadServiceWithOwners = () => {
    jest.doMock("../../src/config/prisma", () => ({
      __esModule: true,
      default: { user: { findMany: jest.fn().mockResolvedValue(OWNERS) } },
    }));
    jest.doMock("../../src/services/hubspotOAuthService", () => ({
      HubSpotOAuthService: {
        getValidAccessToken: jest.fn().mockRejectedValue(new Error("no token")),
      },
    }));
    jest.doMock("../../src/services/hubspotHelpers", () => ({
      getOwnerById: jest.fn(),
    }));
    return require("../../src/services/hubspotOwnersService");
  };

  it("resolves an owner by exact email match", async () => {
    const { getConnectedOwnerByEmail } = loadServiceWithOwners();
    const owner = await getConnectedOwnerByEmail("alice@example.com");
    expect(owner?.id).toBe("1");
  });

  it("matches case-insensitively", async () => {
    const { getConnectedOwnerByEmail } = loadServiceWithOwners();
    const owner = await getConnectedOwnerByEmail("ALICE@EXAMPLE.COM");
    expect(owner?.id).toBe("1");
  });

  it("returns undefined for an unknown email", async () => {
    const { getConnectedOwnerByEmail } = loadServiceWithOwners();
    const owner = await getConnectedOwnerByEmail("nobody@example.com");
    expect(owner).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- hubspotOwnersService`
Expected: FAIL — `getConnectedOwnerByEmail is not a function` (or `undefined`).

- [ ] **Step 3: Implement it**

Edit `backend/src/services/hubspotOwnersService.ts`:

Change the `ConnectedOwner` interface (lines 13-16):

```ts
export interface ConnectedOwner {
  id: string; // our User.id
  name: string | null; // HubSpot display name (falls back to DB name on failure)
  email: string | null; // our User.email — used to match an external caller's
  // x-requester-email / x-scope-emails headers to an internal owner id.
}
```

Change the `prisma.user.findMany` select (lines 31-38) to include `email`:

```ts
  const users = await prisma.user.findMany({
    where: {
      hubspotAccessToken: { not: null },
      hubspotRefreshToken: { not: null },
      hubspotOwnerId: { not: null },
    },
    select: { id: true, name: true, hubspotOwnerId: true, email: true },
  });
```

Change the mapped return (line 57) to include `email`:

```ts
      return { id: u.id, name, email: u.email ?? null };
```

Add a new export after `getConnectedOwnerNameMap` (end of file):

```ts
// Resolves a single connected owner by email (case-insensitive exact match).
// Used by resolveRequesterScope (middlewares/requesterScope.ts) to map the
// external caller's x-requester-email / x-scope-emails headers to internal
// owner ids.
export async function getConnectedOwnerByEmail(
  email: string,
): Promise<ConnectedOwner | undefined> {
  const target = email.trim().toLowerCase();
  const owners = await getConnectedOwners();
  return owners.find((o) => o.email?.toLowerCase() === target);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- hubspotOwnersService`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/hubspotOwnersService.ts backend/tests/services/hubspotOwnersService.test.ts
git commit -m "feat: add getConnectedOwnerByEmail to hubspotOwnersService"
```

---

### Task 8: Scope helper + `resolveOwnerScope` intersection (`publicController.ts`)

**Files:**
- Modify: `backend/src/controllers/publicController.ts`
- Test: `backend/tests/controllers/publicController.scope.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyRequesterScope(ownerIds: string[], scopeOwnerIds: string[] | null | undefined): string[]` (exported), `resolveOwnerScope` becomes exported — used by Task 11 (`getSummary`/`getFilters` wiring) and by the 4 list endpoints (`getConnections`/`getMessages`/`getLateMessages`/`getMissedFollowUps`), all of which already call `resolveOwnerScope` and need no further change once this task lands.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/controllers/publicController.scope.test.ts`:

```ts
import { applyRequesterScope, resolveOwnerScope } from "../../src/controllers/publicController";

describe("applyRequesterScope", () => {
  it("returns all owner ids unchanged when scope is null (unrestricted)", () => {
    expect(applyRequesterScope(["a", "b"], null)).toEqual(["a", "b"]);
  });

  it("intersects owner ids with an explicit scope list", () => {
    expect(applyRequesterScope(["a", "b", "c"], ["b", "c", "z"])).toEqual(["b", "c"]);
  });

  it("fails closed (empty) when scope is undefined", () => {
    expect(applyRequesterScope(["a", "b"], undefined)).toEqual([]);
  });
});

describe("resolveOwnerScope", () => {
  const ownerIds = ["a", "b", "c"];

  it("scopes the fallback (no filter) case to the requester's allowed owners", () => {
    const req = { query: {}, scopeOwnerIds: ["a"] } as any;
    expect(resolveOwnerScope(req, ownerIds)).toEqual({ userId: undefined, userIds: ["a"] });
  });

  it("still validates ?userId against the scoped set, not the full owner list", () => {
    const req = { query: { userId: "b" }, scopeOwnerIds: ["a"] } as any;
    expect(resolveOwnerScope(req, ownerIds)).toEqual({ userId: undefined, userIds: ["a"] });
  });

  it("allows an unrestricted requester (scopeOwnerIds: null) to pick any owner", () => {
    const req = { query: { userId: "b" }, scopeOwnerIds: null } as any;
    expect(resolveOwnerScope(req, ownerIds)).toEqual({ userId: "b", userIds: undefined });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- publicController.scope`
Expected: FAIL — `applyRequesterScope is not a function` (not yet exported/defined).

- [ ] **Step 3: Implement it**

Edit `backend/src/controllers/publicController.ts`. Add this exported function right after the `pickOwners` definition (line 151):

```ts
// Intersects a full owner-id list with the requester's allowed scope.
// null means unrestricted (x-scope: all — see requesterScope.ts). undefined
// means resolveRequesterScope hasn't run (shouldn't happen once publicRoutes
// wires it in — see Task 12) — fails closed to "no access" rather than
// silently falling back to unrestricted.
export const applyRequesterScope = (
  ownerIds: string[],
  scopeOwnerIds: string[] | null | undefined,
): string[] => {
  if (scopeOwnerIds === null) return ownerIds;
  if (!scopeOwnerIds) return [];
  const allowed = new Set(scopeOwnerIds);
  return ownerIds.filter((id) => allowed.has(id));
};
```

Then change `resolveOwnerScope` (lines 408-419 — the leading comment plus the function) to export it and intersect with `req.scopeOwnerIds` before validating `?userId`/`?userIds` against it:

```ts
// Resolves the owner scope for a list endpoint: a single validated userId
// (from ?userId), else a validated multi-select subset (from ?userIds), else
// every owner the requester is allowed to see. The candidate ownerIds list is
// first narrowed to the requester's scope (see applyRequesterScope) — a
// query param can never widen access beyond what x-requester-email/
// x-scope-emails/x-scope already granted.
export const resolveOwnerScope = (
  req: Request & { scopeOwnerIds?: string[] | null },
  ownerIds: string[],
): { userId: string | undefined; userIds: string[] | undefined } => {
  const scopedIds = applyRequesterScope(ownerIds, req.scopeOwnerIds);
  const userId = pickOwner(req.query.userId, scopedIds);
  if (userId) return { userId, userIds: undefined };
  const userIds = pickOwners(req.query.userIds, scopedIds);
  return { userId: undefined, userIds: userIds.length > 0 ? userIds : scopedIds };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- publicController.scope`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/publicController.ts backend/tests/controllers/publicController.scope.test.ts
git commit -m "feat: scope resolveOwnerScope to the requester's allowed owners"
```

---

### Task 9: `resolveRequesterScope` middleware

**Files:**
- Create: `backend/src/middlewares/requesterScope.ts`
- Test: `backend/tests/middlewares/requesterScope.test.ts`

**Interfaces:**
- Consumes: `getConnectedOwnerByEmail` from Task 7; `PublicApiRequest` from Task 6.
- Produces: `resolveRequesterScope(req: PublicApiRequest, res, next)`, sets `req.requesterOwnerId` and `req.scopeOwnerIds` — used by Task 12 (`publicRoutes.ts`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/middlewares/requesterScope.test.ts`:

```ts
jest.mock("../../src/services/hubspotOwnersService", () => ({
  getConnectedOwnerByEmail: jest.fn(),
}));

import { getConnectedOwnerByEmail } from "../../src/services/hubspotOwnersService";
import { resolveRequesterScope } from "../../src/middlewares/requesterScope";

const mockedGetOwner = getConnectedOwnerByEmail as jest.Mock;

const buildReq = (headers: Record<string, string>) => ({ headers }) as any;
const res = {} as any;

const owner = (id: string, email: string) => ({ id, name: id, email });

describe("resolveRequesterScope", () => {
  beforeEach(() => jest.clearAllMocks());

  it("400s when x-requester-email is missing", async () => {
    const next = jest.fn();
    await resolveRequesterScope(buildReq({}), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(mockedGetOwner).not.toHaveBeenCalled();
  });

  it("403s when the requester email doesn't match a connected owner", async () => {
    mockedGetOwner.mockResolvedValueOnce(undefined);
    const next = jest.fn();
    await resolveRequesterScope(
      buildReq({ "x-requester-email": "ghost@example.com" }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("defaults to self-only scope when no scope headers are given", async () => {
    mockedGetOwner.mockResolvedValueOnce(owner("u1", "rep@example.com"));
    const req = buildReq({ "x-requester-email": "rep@example.com" });
    const next = jest.fn();
    await resolveRequesterScope(req, res, next);
    expect(req.scopeOwnerIds).toEqual(["u1"]);
    expect(req.requesterOwnerId).toBe("u1");
    expect(next).toHaveBeenCalledWith();
  });

  it("x-scope: all unlocks unrestricted access (null)", async () => {
    mockedGetOwner.mockResolvedValueOnce(owner("u1", "admin@example.com"));
    const req = buildReq({ "x-requester-email": "admin@example.com", "x-scope": "all" });
    const next = jest.fn();
    await resolveRequesterScope(req, res, next);
    expect(req.scopeOwnerIds).toBeNull();
  });

  it("resolves x-scope-emails, always including the requester, dropping unknowns", async () => {
    mockedGetOwner
      .mockResolvedValueOnce(owner("u1", "manager@example.com")) // requester
      .mockResolvedValueOnce(owner("u2", "rep-a@example.com")) // scope email 1
      .mockResolvedValueOnce(undefined); // scope email 2, unknown

    const req = buildReq({
      "x-requester-email": "manager@example.com",
      "x-scope-emails": "rep-a@example.com,ghost@example.com",
    });
    const next = jest.fn();
    await resolveRequesterScope(req, res, next);
    expect(req.scopeOwnerIds).toEqual(expect.arrayContaining(["u1", "u2"]));
    expect(req.scopeOwnerIds).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- requesterScope`
Expected: FAIL — `Cannot find module '../../src/middlewares/requesterScope'`.

- [ ] **Step 3: Implement it**

Create `backend/src/middlewares/requesterScope.ts`:

```ts
import { Response, NextFunction } from "express";
import { getConnectedOwnerByEmail } from "../services/hubspotOwnersService";
import { PublicApiRequest } from "../types";
import { ForbiddenError, ValidationError } from "../errors/AppError";
import logger from "../utils/logger";

const toStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const header = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

// Runs after requireApiKey. Resolves who this call is on behalf of and what
// they're allowed to see, from three trusted headers (see spec §3):
//   x-requester-email (required) — who this call is on behalf of.
//   x-scope: all (optional)      — unrestricted access (super_admin).
//   x-scope-emails (optional)    — comma-separated emails this person may
//                                   see; the requester's own id is always
//                                   included even if omitted from the list.
// Fail-closed: neither optional header given -> self only (req.scopeOwnerIds
// = [requesterOwnerId]). An x-requester-email that isn't a recognized
// connected owner is a 403; a missing one is a 400.
export const resolveRequesterScope = async (
  req: PublicApiRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const requesterEmail = toStr(header(req.headers["x-requester-email"]));
    if (!requesterEmail) {
      return next(new ValidationError("x-requester-email header is required"));
    }

    const requester = await getConnectedOwnerByEmail(requesterEmail);
    if (!requester) {
      return next(new ForbiddenError("Requester is not a recognized owner"));
    }

    req.requesterOwnerId = requester.id;

    const scopeHeader = toStr(header(req.headers["x-scope"]));
    if (scopeHeader === "all") {
      req.scopeOwnerIds = null;
      return next();
    }

    const scopeEmailsHeader = toStr(header(req.headers["x-scope-emails"]));
    if (scopeEmailsHeader) {
      const emails = scopeEmailsHeader
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      const resolved = new Set<string>();
      for (const email of emails) {
        const scopedOwner = await getConnectedOwnerByEmail(email);
        if (scopedOwner) {
          resolved.add(scopedOwner.id);
        } else {
          logger.warn("[requesterScope] dropping unrecognized scope email", { email });
        }
      }
      resolved.add(requester.id); // always include the requester's own id
      req.scopeOwnerIds = Array.from(resolved);
      return next();
    }

    req.scopeOwnerIds = [requester.id]; // safe default: self only
    next();
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- requesterScope`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/middlewares/requesterScope.ts backend/tests/middlewares/requesterScope.test.ts
git commit -m "feat: add resolveRequesterScope middleware"
```

---

### Task 10: Wire scoping into `getSummary` and `getFilters`

**Files:**
- Modify: `backend/src/controllers/publicController.ts`

**Interfaces:**
- Consumes: `applyRequesterScope` from Task 8; `PublicApiRequest` from Task 6.
- Produces: `getFilters`/`getSummary` now return owner/account lists narrowed to the requester's scope. No new exports.

No dedicated unit test: `getSummary` fans out to 5 services via `Promise.all` (`ConnectionService`, `ConnectionEventService`, `MessageEventService`, `LateMessageService`, `MissedFollowUpService`) with no existing test seams, and the scoping logic itself (`applyRequesterScope`) is already fully covered by Task 8. This task is call-site wiring, verified by the type-check in Step 4 and by Task 13's manual role-scenario walkthrough (spec's own "Testing" section treats the 6-endpoint integration check as manual).

- [ ] **Step 1: Update `getFilters`**

Edit `backend/src/controllers/publicController.ts`. Change the `getFilters` signature and body (lines 171-185) from:

```ts
export const getFilters = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const owners = await getConnectedOwners();
    const { accounts: linkedinAccounts, pairs: ownerAccounts } = await getLinkedinAccountsData(
      owners.map((o) => o.id),
    );
    successResponse(res, { users: owners, linkedinAccounts, ownerAccounts }, "Filters retrieved");
  } catch (error) {
    next(error);
  }
};
```

to:

```ts
export const getFilters = async (
  req: PublicApiRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const owners = await getConnectedOwners();
    const scopedOwnerIds = applyRequesterScope(owners.map((o) => o.id), req.scopeOwnerIds);
    const scopedOwners = owners.filter((o) => scopedOwnerIds.includes(o.id));
    const { accounts: linkedinAccounts, pairs: ownerAccounts } =
      await getLinkedinAccountsData(scopedOwnerIds);
    successResponse(
      res,
      { users: scopedOwners, linkedinAccounts, ownerAccounts },
      "Filters retrieved",
    );
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 2: Update `getSummary`**

In the same file, change the `getSummary` signature (line 190) from `req: Request` to `req: PublicApiRequest`.

Right after the owner-list derivation (lines 207-208):

```ts
    const owners = await getConnectedOwners();
    const ownerIds = owners.map((o) => o.id);
```

insert:

```ts
    const scopedOwnerIds = applyRequesterScope(ownerIds, req.scopeOwnerIds);
```

Then replace every subsequent use of the bare `ownerIds` in this function with `scopedOwnerIds`:

- Line 209: `const userId = pickOwner(req.query.userId, ownerIds);` → `const userId = pickOwner(req.query.userId, scopedOwnerIds);`
- Line 225: `const breakdownOwnerIds = pickOwners(req.query.ownerIds, ownerIds);` → `const breakdownOwnerIds = pickOwners(req.query.ownerIds, scopedOwnerIds);`
- Line 236: `const ownerScope = breakdownOwnerIds.length ? breakdownOwnerIds : ownerIds;` → `const ownerScope = breakdownOwnerIds.length ? breakdownOwnerIds : scopedOwnerIds;`
- Line 309: `getLinkedinAccounts(ownerIds),` → `getLinkedinAccounts(scopedOwnerIds),`
- Line 376: `const pendingNow = await ConnectionService.getStats(userId, ownerScope);` — unchanged (already reads from the now-scoped `ownerScope`).
- Line 398 (inside the `successResponse` payload): `users: owners,` → `users: owners.filter((o) => scopedOwnerIds.includes(o.id)),`

- [ ] **Step 3: Fix the stale doc comment**

The comment block at lines 105-108 currently reads:

```ts
// These endpoints are intentionally UNAUTHENTICATED (see publicRoutes.ts): they
// serve read-only reporting data to the Chitragupt frontend (no login yet).
// Scope is limited to HubSpot-CONNECTED owners only, and owner names come from
// HubSpot (not our users table).
```

Replace it with:

```ts
// These endpoints are gated by a shared API key (requireApiKey) plus
// per-request role-based data scoping (resolveRequesterScope) — see
// docs/superpowers/specs/2026-09-22-role-scoped-reports-api-design.md.
// Scope is limited to HubSpot-CONNECTED owners only, further narrowed to
// whichever of those the requester is allowed to see (req.scopeOwnerIds);
// owner names come from HubSpot (not our users table).
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit` (from `backend/`)
Expected: no errors.

- [ ] **Step 5: Re-run the full suite**

Run: `npm test`
Expected: PASS, all tests from Tasks 1-9 still green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/publicController.ts
git commit -m "feat: scope getSummary/getFilters owner and account lists to the requester"
```

---

### Task 11: Rewire `publicRoutes.ts`

**Files:**
- Modify: `backend/src/routes/publicRoutes.ts`
- Modify: `backend/src/routes/index.ts` (stale comment)

**Interfaces:**
- Consumes: `requireApiKey` from Task 6, `resolveRequesterScope` from Task 9.
- Produces: the live route chain the whole feature depends on.

- [ ] **Step 1: Replace the middleware chain**

Replace `backend/src/routes/publicRoutes.ts` in full:

```ts
import { Router } from "express";
import {
  getSummary,
  getFilters,
  getConnections,
  getMessages,
  getLateMessages,
  getMissedFollowUps,
} from "../controllers/publicController";
import { requireApiKey } from "../middlewares/apiKey";
import { resolveRequesterScope } from "../middlewares/requesterScope";

// Read-only router serving global connection/message data to the external
// reporting frontend (a separate project, server-to-server only). Gated by a
// shared, revocable API key (requireApiKey) plus per-request, role-based
// data scoping resolved from trusted headers (resolveRequesterScope) — see
// docs/superpowers/specs/2026-09-22-role-scoped-reports-api-design.md.
// Still inherits the global IP `apiLimiter` from routes/index.ts.
// Do NOT add write endpoints here.
const router = Router();

router.use(requireApiKey);
router.use(resolveRequesterScope);

router.get("/summary", getSummary);
router.get("/filters", getFilters);
router.get("/connections", getConnections);
router.get("/messages", getMessages);
router.get("/late-messages", getLateMessages);
router.get("/missed-followups", getMissedFollowUps);

export default router;
```

- [ ] **Step 2: Fix the stale comment in the route index**

Edit `backend/src/routes/index.ts` line 21, from:

```ts
// Public, unauthenticated read-only endpoints for the reporting frontend.
```

to:

```ts
// API-key-gated, role-scoped read-only endpoints for the external reporting frontend.
```

- [ ] **Step 3: Confirm the old env var is fully gone**

Run: `grep -rn "PUBLIC_API_KEY\|publicApiKey" backend/src`
Expected: no matches (Task 6 already deleted `publicApiKey.ts` and its env var; this step confirms Task 11's route rewrite removed the last reference).

- [ ] **Step 4: Type-check the whole project**

Run: `npx tsc --noEmit` (from `backend/`)
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/publicRoutes.ts backend/src/routes/index.ts
git commit -m "feat: gate /api/public/* behind requireApiKey + resolveRequesterScope"
```

---

### Task 12: Manual verification (per spec's Testing section)

**Files:** none — verification only.

The spec explicitly calls for a manual pass issuing a real key and exercising all 4 role scenarios before wiring up the Next.js side. Do this against a real (dev) database, `DATABASE_URL` pointed at it.

- [ ] **Step 1: Start the server**

Run: `npm run dev` (from `backend/`)

- [ ] **Step 2: Log in and issue an API key**

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<your login email>","password":"<your password>"}'
# copy the access token from the response, then:
curl -X POST http://localhost:3000/api/auth/api-keys \
  -H "Authorization: Bearer <access token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"manual verification"}'
# copy the returned rawKey — it will not be shown again
```

Expected: 201, `{ id, rawKey }`, `rawKey` starts with `lnk_`.

- [ ] **Step 3: No `x-api-key` → 401**

```bash
curl -i http://localhost:3000/api/public/summary
```

Expected: 401, generic "Invalid or missing API key".

- [ ] **Step 4: Valid key, no `x-requester-email` → 400**

```bash
curl -i http://localhost:3000/api/public/summary -H "x-api-key: <rawKey>"
```

Expected: 400, "x-requester-email header is required".

- [ ] **Step 5: Unrecognized requester → 403**

```bash
curl -i http://localhost:3000/api/public/summary \
  -H "x-api-key: <rawKey>" \
  -H "x-requester-email: nobody@nowhere.invalid"
```

Expected: 403, "Requester is not a recognized owner".

- [ ] **Step 6: `user` role — default self-only scope**

```bash
curl http://localhost:3000/api/public/summary \
  -H "x-api-key: <rawKey>" \
  -H "x-requester-email: <a real connected owner's email>"
```

Expected: 200; the `users` array in the response contains only that one owner.

- [ ] **Step 7: `manager`/`admin` role — explicit `x-scope-emails`**

```bash
curl http://localhost:3000/api/public/summary \
  -H "x-api-key: <rawKey>" \
  -H "x-requester-email: <manager's email>" \
  -H "x-scope-emails: <report A's email>,<report B's email>"
```

Expected: 200; `users` contains the manager plus both reports (3 total), regardless of whether the manager's own email was in the list.

- [ ] **Step 8: `super_admin` role — `x-scope: all`**

```bash
curl http://localhost:3000/api/public/summary \
  -H "x-api-key: <rawKey>" \
  -H "x-requester-email: <any connected owner's email>" \
  -H "x-scope: all"
```

Expected: 200; `users` contains every connected owner (same as today's unscoped behavior).

- [ ] **Step 9: Repeat steps 6-8 against the other 5 endpoints**

`GET /api/public/filters`, `/connections`, `/messages`, `/late-messages`, `/missed-followups` — confirm each one's returned rows/owner lists are scoped identically to `/summary`'s behavior for the same headers.

- [ ] **Step 10: Revoke the key and confirm it's rejected**

```bash
curl -X DELETE http://localhost:3000/api/auth/api-keys/<id> \
  -H "Authorization: Bearer <access token>"
curl -i http://localhost:3000/api/public/summary -H "x-api-key: <rawKey>"
```

Expected: DELETE returns 200; the subsequent request returns 401 with the same generic message as step 3 (never "revoked" specifically).

- [ ] **Step 11: List keys and confirm the raw key is never exposed again**

```bash
curl http://localhost:3000/api/auth/api-keys -H "Authorization: Bearer <access token>"
```

Expected: 200; the array shows `keyPrefix` only (e.g. `"lnk_a1b2c3d4"`), no `keyHash`, no full raw key.

---

## Self-Review Notes

- **Spec coverage:** §1 issuance → Tasks 2-5. §2 request-time auth → Task 6. §3 scope resolution → Tasks 7, 9. §4 controller integration → Tasks 8, 10. §5 route changes → Task 11. Error handling → covered across Tasks 6, 9, verified manually in Task 12 (steps 3-5, 10). Testing section's "Unit" bullet → Tasks 8, 9 tests. "Manual" bullet → Task 12. Testing section's "Integration" bullet (all 6 endpoints, varying scope headers) is intentionally handled as manual verification (Task 12, step 9) rather than automated — this repo has no DB-backed integration test harness today and standing one up (test database, seed data, teardown) is out of scope for this feature; flagged here rather than silently dropped.
- **Placeholder scan:** no TBD/TODO — every step has concrete code or an exact command.
- **Type consistency:** `PublicApiRequest` (Task 6) is the one shared type threaded through Task 9 (`requesterScope.ts`), Task 10 (`getFilters`/`getSummary`), and Task 11 (route wiring); `applyRequesterScope`/`resolveOwnerScope` (Task 8) signatures match their Task 10 call sites exactly (`scopeOwnerIds: string[] | null | undefined`).
