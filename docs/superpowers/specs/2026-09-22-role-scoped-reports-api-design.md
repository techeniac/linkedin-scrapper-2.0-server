# Role-Scoped External Access to the Reports API

Date: 2026-09-22

## Problem

A separate Next.js project (AWS Amplify, monorepo) needs to consume this
project's `/api/public/*` reporting endpoints (summary, filters, connections,
messages, late-messages, missed-followups). The two projects have unrelated
auth systems (this project: JWT/users table; the other: its own 4-role
system — `user`, `manager`, `admin`, `super_admin`).

Two things are needed:
1. A trusted, revocable credential the other project's server can use to call
   this API (server-to-server only — confirmed the Next.js calls will always
   originate from server-side code, never the browser).
2. Per-request, role-based data scoping: a `user` sees only their own data; a
   `manager`/`admin` sees their own data plus the people they manage; a
   `super_admin` sees everything. The role hierarchy itself is owned entirely
   by the other project (Approach A, confirmed) — this backend never stores
   or computes org structure, it only receives an already-resolved scope.

## Non-goals

- No change to how the report data itself is computed/aggregated.
- No per-external-user API keys — one shared key for the whole external
  project (confirmed: server-to-server, single trusted caller).
- No support for browser-originated calls from the other project (if that
  need arises later, it requires a proxy pattern — out of scope here).
- The old same-project frontend JWT path on `/api/public/*` is being retired
  as part of this change (confirmed not in use going forward) — these routes
  become API-key-only.

## Design

### 1. API key issuance (self-service, admin-gated)

New `ApiKey` model (`prisma/schema.prisma`):

```prisma
model ApiKey {
  id         String    @id @default(uuid())
  name       String
  keyHash    String    @unique
  keyPrefix  String
  revokedAt  DateTime?
  lastUsedAt DateTime?
  expiresAt  DateTime?
  createdAt  DateTime  @default(now())
}
```

One shared key for the entire external project — no `userId` relation. Not
tied to a specific human; it authenticates "this call is really from my
trusted Next.js server," nothing more.

- `POST /api/auth/api-keys` — gated by existing `authenticate` (your own
  login). Generates `crypto.randomBytes(32).toString("hex")` with a `lnk_`
  prefix, stores SHA-256 hash, returns the **raw key once**. Never
  retrievable again (same pattern as `tokenService.ts`'s refresh tokens).
- `GET /api/auth/api-keys` — list, masked (`keyPrefix` only).
- `DELETE /api/auth/api-keys/:id` — sets `revokedAt`.
- `expiresAt` is stored but not required/enforced by default (no
  auto-expiry) — present so a future expiry policy needs no migration.

### 2. Request-time auth: `middlewares/apiKey.ts`

Replaces the old static-env-var `publicApiKey.ts`. Reads `x-api-key`,
hashes it, looks up `ApiKey` by `keyHash`, rejects (401) if not found,
revoked, or expired. Updates `lastUsedAt` (fire-and-forget, doesn't block
the request).

### 3. Request-time scope resolution: `middlewares/requesterScope.ts`

Runs after `requireApiKey`. Reads three headers:

| Header | Required | Meaning |
|---|---|---|
| `x-requester-email` | yes | Who this call is on behalf of |
| `x-scope-emails` | no | Comma-separated emails this person may see (self + reports) |
| `x-scope` | no | Only the literal value `all` has effect — unlocks full access (super_admin) |

Resolution logic (fail-closed):

1. Resolve `x-requester-email` to an internal owner id via
   `getConnectedOwnerByEmail` (new helper, extends `hubspotOwnersService.ts`
   — the `ConnectedOwner` cache gains an `email` field sourced from
   `User.email`). If it doesn't resolve → 403 (this person isn't a tracked
   owner in this system at all).
2. If `x-scope: all` → `req.scopeOwnerIds = null` (unrestricted).
3. Else if `x-scope-emails` present → resolve each to an internal id,
   silently drop ones that don't match a connected owner (warn-logged, same
   defensive pattern as the existing `pickOwners`), dedupe, always include
   the requester's own resolved id even if it wasn't in the list.
4. Else (neither given) → `req.scopeOwnerIds = [resolvedRequesterId]` — self
   only. This is the safe default: forgetting to pass scope never
   accidentally grants broader access.

### 4. Controller integration

`publicController.ts`'s `resolveOwnerScope()` (existing, `:411-419`)
intersects its `userId`/`userIds` query-param resolution with
`req.scopeOwnerIds` instead of validating against the full connected-owner
list. When `req.scopeOwnerIds` is `null` (super_admin), behavior is
identical to today (no restriction). Same intersection applies everywhere
`ownerIds`/`breakdownOwnerIds` are derived in `getSummary` (`:190-406`).

### 5. Route changes

`publicRoutes.ts`: remove `authenticate` entirely. New chain:
`requireApiKey` → `resolveRequesterScope` → controller. `apiLimiter`
(global IP rate limit) stays as-is.

## Data flow (example: `GET /api/public/summary`)

1. `requireApiKey` validates `x-api-key` → 401 on failure.
2. `resolveRequesterScope` resolves `x-requester-email`/`x-scope-emails`/
   `x-scope` → `req.scopeOwnerIds`.
3. Controller's existing owner/date/account filtering runs unchanged,
   intersected with `req.scopeOwnerIds`.
4. Response shape unchanged.

## Error handling

- Missing/invalid/revoked/expired `x-api-key` → 401, generic message (never
  distinguish "revoked" from "never existed").
- Missing `x-requester-email` → 400.
- `x-requester-email` not a connected owner → 403.
- Unrecognized entries in `x-scope-emails` → dropped silently, logged.

## Testing

- Unit: `resolveRequesterScope` — default self-only, explicit scope list,
  `x-scope: all`, unrecognized requester, partially-invalid scope list.
- Integration: each of the 6 `/api/public/*` endpoints called with varying
  scope headers, confirm data is correctly filtered per scenario (e.g. a
  manager's response includes only self + reports' rows).
- Manual: issue a real key via `POST /api/auth/api-keys`, exercise all 4
  role scenarios via curl/Postman before wiring up the Next.js side.

## Open items for the other project (not part of this backend's scope)

- Look up each rep's internal owner id/email mapping isn't needed — email is
  the shared key, already assumed present on both sides.
- The other project computes `scopeEmails` per its own role hierarchy before
  each call; this backend trusts that computation entirely (traditional
  server-to-server trust boundary, protected by the shared API key).
