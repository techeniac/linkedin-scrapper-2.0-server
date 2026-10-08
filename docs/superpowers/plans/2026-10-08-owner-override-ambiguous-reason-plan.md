# Owner Override — Ambiguous Reason & Participant Name Correction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /api/owner-overrides` tell a human *why* a conversation is ambiguous and give them a LinkedIn deep-link to it, let `POST /api/owner-overrides/:conversationKey` correct/attach a participant name (with full before/after audit history), and reject overriding a conversation that isn't currently `'ambiguous'`.

**Architecture:** Split `MessageOwnerResolverService.resolveOwnerFromHubSpot`'s existing `'ambiguous'`-return branches to each report one of 5 fixed reason codes, thread that code through `ConversationOwnerCacheRepository.upsert` into a new nullable `ambiguous_reason` column. Extend `OwnerOverrideRepository`/`OwnerOverrideService`/`ownerOverrideController` to: read that reason + the current cross-scraper participant name as a pre-override snapshot, enforce a new "must currently be ambiguous" check (409 otherwise), optionally overwrite `message_activity.participant_name` across every scraper row for the conversation, and write 3 new snapshot columns onto `owner_override_audit`. No new files, no new tables — all changes are to 5 existing files plus one migration.

**Tech Stack:** TypeScript / Express / Prisma / PostgreSQL (Supabase).

**Spec:** `backend/docs/superpowers/specs/2026-10-08-owner-override-ambiguous-reason-design.md`

## Global Constraints

- 5 fixed reason codes only: `NO_NAME`, `SINGLE_WORD_NAME`, `NO_HUBSPOT_MATCH`, `MULTIPLE_HUBSPOT_MATCHES`, `OWNER_NOT_CONNECTED` — derived from `resolveOwnerFromHubSpot`'s existing branches, no new resolution logic, no new outcomes.
- `ambiguous_reason` on `conversation_owner_cache` is plain nullable `TEXT` (matches every other attribution-adjacent column in this schema) — cleared to `NULL` whenever a row's `attribution_source` isn't `'ambiguous'`.
- No backfill: the ~17 pre-existing `'ambiguous'` rows keep `ambiguous_reason: null` forever. Not a bug.
- No cross-conversation name→owner memory. A `conversationKey` is the only stickiness key.
- `participantName` is free text, no structural validation beyond non-blank-when-present.
- No frontend confirmation UI — the backend always overwrites when `participantName` is provided.
- `publicController.ts`'s `conversationUrlFromKey` / `THREAD_SLUG_RE` must NOT be imported or modified — it's in active use by 3 unrelated report endpoints. `ownerOverrideController.ts` gets its own local copy.
- No mocking library in this repository. Verification is manual against the real dev DB (`DATABASE_URL` in `backend/.env` already points at it) — same pattern as every prior task in the owner-attribution feature line. No new `*.test.ts` files in this plan.
- Response shape of `POST /api/owner-overrides/:conversationKey` is unchanged: `{ conversationKey, ownerId }`.

## Review Focus

1. **Overriding a conversation whose `attribution_source` is already `'manual'` or `'hubspot'`** (not `'ambiguous'`) — must be rejected with `409`, not silently applied. Pinned in Task 5.
2. **`participantName` present but blank/whitespace-only** (`"   "`) — must be `400`, not a silent no-op and not written as an empty string. Pinned in Task 5.
3. **`participantName` omitted entirely** — audit row's `new_participant_name` must be `NULL` (not `undefined`-coerced-to-empty-string, not copied from the old name) — distinguishable from "a name was provided but matched the old one". Pinned in Task 4.
4. **Multiple `message_activity` rows for one `conversationKey`** (several scrapers touched the same shared LinkedIn account) — a name correction must update ALL of them uniformly, not just one. Pinned in Task 4.
5. **`conversationKey` with no recognizable LinkedIn thread slug** — `conversationUrl` must come back `null`, not throw or return a malformed URL. Pinned in Task 6.

---

### Task 1: Schema — `ambiguous_reason` + audit snapshot columns + `ConflictError`

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20261008120000_add_ambiguous_reason_and_audit_snapshot/migration.sql`
- Modify: `backend/src/errors/AppError.ts`

**Interfaces:**
- Produces: `ConversationOwnerCache.ambiguousReason: string | null`, `OwnerOverrideAudit.ambiguousReason: string | null`, `OwnerOverrideAudit.oldParticipantName: string | null`, `OwnerOverrideAudit.newParticipantName: string | null` (all Prisma-generated client fields) — consumed by Tasks 2–4. `ConflictError extends AppError` (409) — consumed by Task 5.

- [ ] **Step 1: Add the new columns to `schema.prisma`**

In `backend/prisma/schema.prisma`, modify the `ConversationOwnerCache` model (currently lines 406–415):

```prisma
model ConversationOwnerCache {
  conversationKey   String   @id @map("conversation_key")
  resolvedOwnerId   String?  @map("resolved_owner_id")
  resolvedOwner     User?    @relation(fields: [resolvedOwnerId], references: [id], onDelete: SetNull)
  // 'hubspot' | 'fallback' | 'ambiguous' | 'manual' — see MessageEvent.attributionSource above.
  attributionSource String   @map("attribution_source")
  // Set only when attributionSource is 'ambiguous' — one of the 5 codes in
  // MessageOwnerResolverService.AmbiguousReason. NULL on every non-ambiguous
  // row, and permanently NULL on rows resolved before this column existed
  // (see design doc's Non-Goals — no backfill).
  ambiguousReason   String?  @map("ambiguous_reason")
  resolvedAt        DateTime @default(now()) @map("resolved_at")

  @@map("conversation_owner_cache")
}
```

And `OwnerOverrideAudit` (currently lines 427–437):

```prisma
model OwnerOverrideAudit {
  id                 String   @id @default(uuid())
  conversationKey    String   @map("conversation_key")
  oldOwnerId         String?  @map("old_owner_id")
  newOwnerId         String   @map("new_owner_id")
  performedByEmail   String   @map("performed_by_email")
  performedAt        DateTime @default(now()) @map("performed_at")
  // Snapshot of conversation_owner_cache.ambiguous_reason immediately BEFORE
  // this override — history, not live state (the live column gets cleared
  // to NULL by this same override). NULL if the pre-override row had no
  // reason recorded (pre-existing ambiguous row, or this is the first-ever
  // override for a conversation with no ambiguous_reason set).
  ambiguousReason    String?  @map("ambiguous_reason")
  // Participant name in effect immediately before this override
  // (cross-scraper lookup), regardless of whether this override changed it.
  oldParticipantName String?  @map("old_participant_name")
  // The name provided in THIS override's request body, or NULL if no name
  // change was attempted — distinct from "unchanged because it matched the
  // old value" (that case still records the provided value here).
  newParticipantName String?  @map("new_participant_name")

  @@index([conversationKey])
  @@map("owner_override_audit")
}
```

- [ ] **Step 2: Write the migration**

Create `backend/prisma/migrations/20261008120000_add_ambiguous_reason_and_audit_snapshot/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "conversation_owner_cache" ADD COLUMN "ambiguous_reason" TEXT;

-- AlterTable
ALTER TABLE "owner_override_audit"
ADD COLUMN "ambiguous_reason" TEXT,
ADD COLUMN "old_participant_name" TEXT,
ADD COLUMN "new_participant_name" TEXT;
```

- [ ] **Step 3: Apply it against the dev database and regenerate the client**

```bash
cd backend
npx prisma migrate dev --name add_ambiguous_reason_and_audit_snapshot
```

Expected: the migration file from Step 2 already exists on disk under the matching name, so Prisma applies it (or confirms it's already applied) and regenerates the client. Confirm with:

```bash
npx prisma migrate status
```

Expected output ends with "Database schema is up to date!".

- [ ] **Step 4: Add `ConflictError` to `AppError.ts`**

In `backend/src/errors/AppError.ts`, append after the existing `ForbiddenError` class (end of file):

```typescript
export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, 409);
  }
}
```

- [ ] **Step 5: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261008120000_add_ambiguous_reason_and_audit_snapshot src/errors/AppError.ts
git commit -m "feat: add ambiguous_reason + audit snapshot columns, ConflictError"
```

---

### Task 2: `MessageOwnerResolverService` — report the 5 reason codes

**Files:**
- Modify: `backend/src/services/messageOwnerResolverService.ts`

**Interfaces:**
- Consumes: nothing new (same `syncService.findContactOwnerIdByName(firstName, lastName): Promise<{ ownerId: string | null; matchCount: number }>` already used).
- Produces: `export type AmbiguousReason = "NO_NAME" | "SINGLE_WORD_NAME" | "NO_HUBSPOT_MATCH" | "MULTIPLE_HUBSPOT_MATCHES" | "OWNER_NOT_CONNECTED"`. `ResolvedOwner` gains `ambiguousReason?: AmbiguousReason`. `resolveAndPersist` now passes `resolved.ambiguousReason` through to `ConversationOwnerCacheRepository.upsert` (Task 3's new param) — consumed by Task 3.

- [ ] **Step 1: Add the `AmbiguousReason` type and widen `ResolvedOwner`**

In `backend/src/services/messageOwnerResolverService.ts`, replace lines 46–55:

```typescript
export type AttributionSource = "hubspot" | "fallback" | "ambiguous";

// The 5 branches inside resolveOwnerFromHubSpot that can land on
// source: "ambiguous" — see the design doc's table mapping each code to
// its originating condition. Reported, not newly introduced: every branch
// below already returned "ambiguous" before this type existed.
export type AmbiguousReason =
  | "NO_NAME"
  | "SINGLE_WORD_NAME"
  | "NO_HUBSPOT_MATCH"
  | "MULTIPLE_HUBSPOT_MATCHES"
  | "OWNER_NOT_CONNECTED";

export interface ResolvedOwner {
  ownerId: string | null;
  source: AttributionSource;
  // True ONLY when resolution failed to find out (HubSpot-connection or API
  // failure) rather than genuinely finding no owner — see the file header.
  // Absent/falsy for every normal result, including a real "no owner" fact.
  transient?: boolean;
  // Set only when source is "ambiguous" — which of the 5 codes applied.
  ambiguousReason?: AmbiguousReason;
}
```

- [ ] **Step 2: Pass the reason through `resolveAndPersist`**

In the same file, modify the `resolveAndPersist` method (currently lines 58–80), the `upsert` call on line 77:

```typescript
    if (!resolved.transient) {
      await ConversationOwnerCacheRepository.upsert(
        params.conversationKey,
        resolved.ownerId,
        resolved.source,
        resolved.ambiguousReason,
      );
    }
```

- [ ] **Step 3: Report the reason on each branch of `resolveOwnerFromHubSpot`**

In the same file, replace lines 96–136 (the body of `resolveOwnerFromHubSpot` from the `activity` lookup to the end):

```typescript
    const activity = await prisma.messageActivity.findFirst({
      where: { conversationKey, participantName: { not: null } },
      select: { participantName: true },
    });
    const name = activity?.participantName?.trim();
    if (!name) return { ownerId: null, source: "ambiguous", ambiguousReason: "NO_NAME" };

    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ");
    if (!lastName) return { ownerId: null, source: "ambiguous", ambiguousReason: "SINGLE_WORD_NAME" };

    // Only the actual HubSpot round-trip can fail transiently (scraper not
    // HubSpot-connected, rate limit, network blip) — those failures must NOT
    // be cached as a permanent fact. See file header.
    let match: { ownerId: string | null; matchCount: number };
    try {
      const { syncService } = await HubSpotContextService.getContext(scraperUserId);
      match = await syncService.findContactOwnerIdByName(firstName, lastName);
    } catch (err: any) {
      logger.warn(
        `[MessageOwnerResolver] transient resolution failure for conversation ${conversationKey}: ${err?.message}`,
      );
      return { ownerId: null, source: "fallback", transient: true };
    }

    if (match.matchCount === 0) {
      return { ownerId: null, source: "ambiguous", ambiguousReason: "NO_HUBSPOT_MATCH" };
    }
    if (match.matchCount >= 2) {
      return { ownerId: null, source: "ambiguous", ambiguousReason: "MULTIPLE_HUBSPOT_MATCHES" };
    }
    if (!match.ownerId) {
      return { ownerId: null, source: "ambiguous", ambiguousReason: "OWNER_NOT_CONNECTED" };
    }

    const user = await prisma.user.findFirst({
      where: { hubspotOwnerId: match.ownerId },
      select: { id: true },
    });
    // A real HubSpot owner exists but isn't a connected Techeniac user — not
    // a transient failure (HubSpot answered definitively), and not a
    // resolution either. See this plan's Global Constraints ruling.
    if (!user) return { ownerId: null, source: "ambiguous", ambiguousReason: "OWNER_NOT_CONNECTED" };

    return { ownerId: user.id, source: "hubspot" };
```

Note: `match.matchCount !== 1 || !match.ownerId` (the old single `if`) is now 3 separate checks (`=== 0`, `>= 2`, exactly-1-but-no-owner), and the pre-existing "1 match but owner not a connected `User`" case below it now also reports `"OWNER_NOT_CONNECTED"` — this is a report-only split, no branch changes which outcome (`'ambiguous'` vs anything else) a given input reaches.

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: errors pointing at `ConversationOwnerCacheRepository.upsert` expecting 3 args, not 4 — expected, fixed by Task 3. If you see other errors, stop and investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/services/messageOwnerResolverService.ts
git commit -m "feat: report which of the 5 branches produced an ambiguous resolution"
```

---

### Task 3: `ConversationOwnerCacheRepository.upsert` — persist the reason

**Files:**
- Modify: `backend/src/repositories/conversationOwnerCacheRepository.ts`

**Interfaces:**
- Consumes: `AmbiguousReason` type from Task 2 (imported as a type-only import to avoid a circular runtime import — this repository is itself imported by `messageOwnerResolverService.ts`).
- Produces: `ConversationOwnerCacheRepository.upsert(conversationKey: string, resolvedOwnerId: string | null, attributionSource: "hubspot" | "fallback" | "ambiguous" | "manual", ambiguousReason?: string): Promise<void>` — consumed by Task 2 (already wired) and Task 4 (the override path passes nothing, which clears it).

- [ ] **Step 1: Widen `upsert`'s signature and clear-on-non-ambiguous behavior**

In `backend/src/repositories/conversationOwnerCacheRepository.ts`, replace lines 23–33:

```typescript
  static async upsert(
    conversationKey: string,
    resolvedOwnerId: string | null,
    attributionSource: "hubspot" | "fallback" | "ambiguous" | "manual",
    ambiguousReason?: string,
  ): Promise<void> {
    // NULL whenever the source isn't 'ambiguous' — covers both the normal
    // hubspot/fallback resolver outcomes AND the override path (Task 4),
    // which calls this with attributionSource: "manual" and no reason arg.
    const reason = attributionSource === "ambiguous" ? ambiguousReason ?? null : null;
    await prisma.conversationOwnerCache.upsert({
      where: { conversationKey },
      create: { conversationKey, resolvedOwnerId, attributionSource, ambiguousReason: reason },
      update: { resolvedOwnerId, attributionSource, ambiguousReason: reason, resolvedAt: new Date() },
    });
  }
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors (Task 2's extra `upsert` argument now type-checks).

- [ ] **Step 3: Manual verification — trigger each of the 5 ambiguous branches**

With the dev server running (`npm run dev`) and a real `message_activity` row available for each case (seed/observe via the existing scraper flow, per the spec's Testing section item 1), trigger a message event for conversations matching each case and inspect `conversation_owner_cache`:

```sql
SELECT conversation_key, attribution_source, ambiguous_reason FROM conversation_owner_cache WHERE attribution_source = 'ambiguous' ORDER BY resolved_at DESC LIMIT 10;
```

Expected: each newly-ambiguous row shows the correct one of `NO_NAME` / `SINGLE_WORD_NAME` / `NO_HUBSPOT_MATCH` / `MULTIPLE_HUBSPOT_MATCHES` / `OWNER_NOT_CONNECTED` matching the condition you triggered. If a dev-DB conversation matching a given branch isn't readily available, this check may be deferred to Task 7's full pass — do not block this task on it alone.

- [ ] **Step 4: Commit**

```bash
git add src/repositories/conversationOwnerCacheRepository.ts
git commit -m "feat: persist ambiguous_reason, clearing it on non-ambiguous writes"
```

---

### Task 4: `OwnerOverrideRepository` — snapshot lookup, name update, audit columns

**Files:**
- Modify: `backend/src/repositories/ownerOverrideRepository.ts`

**Interfaces:**
- Consumes: `prisma.messageActivity.updateMany`, `prisma.conversationOwnerCache.findUnique` (existing Prisma client methods).
- Produces: `OwnerOverrideRepository.listAmbiguous(...)`'s returned rows gain `ambiguousReason: string | null`. New method `OwnerOverrideRepository.getOverrideSnapshot(conversationKey: string): Promise<{ attributionSource: string | null; ambiguousReason: string | null; participantName: string | null }>` — consumed by Task 5. `OwnerOverrideRepository.applyOverride(...)` gains `participantName?: string`, `ambiguousReason: string | null`, `oldParticipantName: string | null` params — consumed by Task 5.

- [ ] **Step 1: Add `ambiguousReason` to `listAmbiguous`**

In `backend/src/repositories/ownerOverrideRepository.ts`, widen the `AmbiguousConversation` interface (currently lines 9–13):

```typescript
export interface AmbiguousConversation {
  conversationKey: string;
  resolvedAt: Date;
  participantName: string | null;
  ambiguousReason: string | null;
}
```

Then add the column to the `SELECT` inside `listAmbiguous` (currently lines 75–82):

```typescript
      prisma.$queryRaw<AmbiguousConversation[]>`
        SELECT c.conversation_key AS "conversationKey",
               c.resolved_at AS "resolvedAt",
               pn.participant_name AS "participantName",
               c.ambiguous_reason AS "ambiguousReason"
        ${fromAndWhere}
        ORDER BY ${orderClause}
        LIMIT ${limit} OFFSET ${offset}
      `,
```

- [ ] **Step 2: Add `getOverrideSnapshot`**

In the same file, add this method right after `isScraperOfConversation` (after line 105, before `applyOverride`'s doc comment):

```typescript
  /**
   * The "before" state for an override's audit snapshot: the conversation's
   * current attribution_source + ambiguous_reason (to check it's actually
   * overridable, and to snapshot the reason), plus the current cross-scraper
   * participant name (same LATERAL-join reasoning as listAmbiguous's `pn`
   * subquery and the resolver's own cross-scraper lookup — any scraper's
   * captured name for this conversationKey is the "current" one).
   */
  static async getOverrideSnapshot(
    conversationKey: string,
  ): Promise<{ attributionSource: string | null; ambiguousReason: string | null; participantName: string | null }> {
    const cache = await prisma.conversationOwnerCache.findUnique({
      where: { conversationKey },
      select: { attributionSource: true, ambiguousReason: true },
    });
    const activity = await prisma.messageActivity.findFirst({
      where: { conversationKey, participantName: { not: null } },
      select: { participantName: true },
    });
    return {
      attributionSource: cache?.attributionSource ?? null,
      ambiguousReason: cache?.ambiguousReason ?? null,
      participantName: activity?.participantName ?? null,
    };
  }
```

- [ ] **Step 3: Widen `applyOverride`**

In the same file, replace `applyOverride` (currently lines 114–135):

```typescript
  static async applyOverride(params: {
    conversationKey: string;
    oldOwnerId: string | null;
    newOwnerId: string;
    performedByEmail: string;
    participantName?: string;
    ambiguousReason: string | null;
    oldParticipantName: string | null;
  }): Promise<void> {
    const { conversationKey, oldOwnerId, newOwnerId, performedByEmail, participantName, ambiguousReason, oldParticipantName } =
      params;
    await prisma.$transaction([
      prisma.conversationOwnerCache.upsert({
        where: { conversationKey },
        create: { conversationKey, resolvedOwnerId: newOwnerId, attributionSource: "manual" },
        update: { resolvedOwnerId: newOwnerId, attributionSource: "manual", ambiguousReason: null, resolvedAt: new Date() },
      }),
      prisma.messageEvent.updateMany({
        where: { conversationKey },
        data: { resolvedOwnerId: newOwnerId, attributionSource: "manual" },
      }),
      // Uniform across every scraper's row for this conversationKey — see
      // design doc Goal 3 / Review Focus item 4. Only run when a name was
      // actually provided; omitted-field means no name change.
      ...(participantName
        ? [
            prisma.messageActivity.updateMany({
              where: { conversationKey },
              data: { participantName },
            }),
          ]
        : []),
      prisma.ownerOverrideAudit.create({
        data: {
          conversationKey,
          oldOwnerId,
          newOwnerId,
          performedByEmail,
          ambiguousReason,
          oldParticipantName,
          newParticipantName: participantName ?? null,
        },
      }),
    ]);
  }
```

Note: the `create` branch of the `conversation_owner_cache` upsert doesn't set `ambiguousReason` — correct, since Prisma's `create` omits a field defaulting to the column default (`NULL`), and a row reaching this upsert's `create` path (no prior cache row at all) can't have had a prior `'ambiguous'` reason anyway.

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: errors in `ownerOverrideService.ts` (Task 5 fixes the call site). No errors in this file itself.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/ownerOverrideRepository.ts
git commit -m "feat: snapshot lookup, uniform participant-name update, audit columns"
```

---

### Task 5: `OwnerOverrideService` — ambiguous-state guard, name validation, snapshot wiring

**Files:**
- Modify: `backend/src/services/ownerOverrideService.ts`

**Interfaces:**
- Consumes: `OwnerOverrideRepository.getOverrideSnapshot`, widened `OwnerOverrideRepository.applyOverride` (Task 4). `ConflictError` from `../errors/AppError` (Task 1).
- Produces: `AmbiguousConversationDTO` gains `ambiguousReason: string | null`. `OwnerOverrideService.applyOverride(params)` gains `participantName?: string` — consumed by Task 6's controller.

- [ ] **Step 1: Widen `AmbiguousConversationDTO`**

In `backend/src/services/ownerOverrideService.ts`, replace lines 15–19:

```typescript
export interface AmbiguousConversationDTO {
  conversationKey: string;
  participantName: string | null;
  resolvedAt: Date;
  ambiguousReason: string | null;
}
```

(No change needed to `listAmbiguous`'s body — it already spreads `data` straight from the repository, which now includes `ambiguousReason` per Task 4 Step 1.)

- [ ] **Step 2: Import `ConflictError`**

Replace line 11:

```typescript
import { ValidationError, ForbiddenError, ConflictError } from "../errors/AppError";
```

- [ ] **Step 3: Add the ambiguous-state guard, name validation, and snapshot wiring to `applyOverride`**

Replace `applyOverride` (currently lines 74–103):

```typescript
  static async applyOverride(params: {
    conversationKey: string;
    newOwnerId: string;
    requesterEmail: string;
    scope: RequesterScope;
    participantName?: string;
  }): Promise<void> {
    if (params.scope === "regular") {
      const scraperUserId = await this.resolveScraperUserId(params.requesterEmail);
      const isScraper = scraperUserId
        ? await OwnerOverrideRepository.isScraperOfConversation(params.conversationKey, scraperUserId)
        : false;
      if (!isScraper) {
        throw new ForbiddenError("Not authorized to override this conversation");
      }
    }

    const connectedIds = await getConnectedOwnerIds();
    if (!connectedIds.includes(params.newOwnerId)) {
      throw new ValidationError("ownerId must be a HubSpot-connected owner");
    }

    // Present-but-blank is rejected; absent is "no name change attempted"
    // and is left as undefined all the way through to the repository.
    let participantName: string | undefined;
    if (params.participantName !== undefined) {
      const trimmed = params.participantName.trim();
      if (!trimmed) {
        throw new ValidationError("participantName must not be blank");
      }
      participantName = trimmed;
    }

    const snapshot = await OwnerOverrideRepository.getOverrideSnapshot(params.conversationKey);
    if (snapshot.attributionSource !== "ambiguous") {
      throw new ConflictError("Conversation is not in a resolvable state");
    }

    const cached = await OwnerOverrideRepository.findCachedOwner(params.conversationKey);
    await OwnerOverrideRepository.applyOverride({
      conversationKey: params.conversationKey,
      oldOwnerId: cached?.resolvedOwnerId ?? null,
      newOwnerId: params.newOwnerId,
      performedByEmail: params.requesterEmail,
      participantName,
      ambiguousReason: snapshot.ambiguousReason,
      oldParticipantName: snapshot.participantName,
    });
  }
```

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: errors only in `ownerOverrideController.ts` (`applyOverride` called without the new optional field is still valid TypeScript — if you see errors elsewhere, stop and investigate).

- [ ] **Step 5: Manual verification — the 409 and 400 cases**

With the dev server running, using a real `conversationKey` already cached as `'hubspot'` or `'manual'` (not `'ambiguous'`) and a real connected `ownerId`:

```bash
curl -s -X POST http://localhost:<port>/api/owner-overrides/<non-ambiguous-key> \
  -H "x-api-key: <key>" -H "x-requester-email: <email>" -H "Content-Type: application/json" \
  -d '{"ownerId":"<connected-owner-id>"}'
```

Expected: HTTP 409, body message "Conversation is not in a resolvable state".

Then, against a real `'ambiguous'`-cached `conversationKey`:

```bash
curl -s -X POST http://localhost:<port>/api/owner-overrides/<ambiguous-key> \
  -H "x-api-key: <key>" -H "x-requester-email: <email>" -H "Content-Type: application/json" \
  -d '{"ownerId":"<connected-owner-id>","participantName":"   "}'
```

Expected: HTTP 400, body message "participantName must not be blank".

- [ ] **Step 6: Commit**

```bash
git add src/services/ownerOverrideService.ts
git commit -m "feat: require ambiguous state before override, validate participantName"
```

---

### Task 6: `ownerOverrideController` — `conversationUrl`, `ambiguousReason`, request parsing

**Files:**
- Modify: `backend/src/controllers/ownerOverrideController.ts`

**Interfaces:**
- Consumes: `OwnerOverrideService.listAmbiguous` (now returns `ambiguousReason` per Task 5), `OwnerOverrideService.applyOverride` (now accepts `participantName` per Task 5).
- Produces: `GET /api/owner-overrides` response rows gain `ambiguousReason` and `conversationUrl`. `POST /api/owner-overrides/:conversationKey` accepts optional `participantName` in the body.

- [ ] **Step 1: Add the local `conversationUrlFromKey` copy**

In `backend/src/controllers/ownerOverrideController.ts`, add after the existing imports (after line 7):

```typescript
// Deliberately a fresh, local copy of the same slug-extraction technique as
// publicController.ts's conversationUrlFromKey — that helper is in active
// use by 3 unrelated report endpoints and must not be touched or imported
// cross-module for this feature (see design doc).
const THREAD_SLUG_RE = /2-[A-Za-z0-9_=-]+/;
const conversationUrlFromKey = (conversationKey: string): string | null => {
  const slug = conversationKey.match(THREAD_SLUG_RE)?.[0];
  return slug ? `https://www.linkedin.com/messaging/thread/${slug}/` : null;
};
```

- [ ] **Step 2: Map the new fields onto `listOwnerOverrides`'s response**

Replace the body of `listOwnerOverrides` (currently lines 37–56):

```typescript
export const listOwnerOverrides = async (
  req: RequesterRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await OwnerOverrideService.listAmbiguous({
      requesterEmail: req.requesterEmail!,
      scope: req.requesterScope!,
      page: toPage(req.query.page),
      limit: toLimit(req.query.limit),
      sortBy: toSortBy(req.query.sortBy),
      sortOrder: toSortOrder(req.query.sortOrder),
      search: toStr(req.query.search),
    });
    const data = result.data.map((row) => ({
      ...row,
      conversationUrl: conversationUrlFromKey(row.conversationKey),
    }));
    successResponse(res, { data, metadata: result.metadata }, "Ambiguous conversations retrieved");
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 3: Parse `participantName` in `applyOwnerOverride`**

Replace the body of `applyOwnerOverride` (currently lines 59–81):

```typescript
export const applyOwnerOverride = async (
  req: RequesterRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const conversationKey = req.params.conversationKey;
    const ownerId = typeof req.body?.ownerId === "string" ? req.body.ownerId.trim() : "";
    if (!conversationKey || !ownerId) {
      throw new ValidationError("conversationKey and ownerId are required");
    }
    // Absent field vs. present-but-blank are different signals downstream
    // (OwnerOverrideService.applyOverride) — pass the raw string through
    // untrimmed so blank-after-trim can still be rejected there, and leave
    // it undefined (not "") when the field wasn't sent at all.
    const participantName = typeof req.body?.participantName === "string" ? req.body.participantName : undefined;

    await OwnerOverrideService.applyOverride({
      conversationKey,
      newOwnerId: ownerId,
      requesterEmail: req.requesterEmail!,
      scope: req.requesterScope!,
      participantName,
    });
    successResponse(res, { conversationKey, ownerId }, "Owner override applied");
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 4: Update the route-doc comments**

Replace the comment above `listOwnerOverrides` (currently lines 31–36) and above `applyOwnerOverride` (currently line 58) to reflect the new fields:

```typescript
// GET /api/owner-overrides — every conversation currently needing a manual
// resolution, scoped per requireRequesterContext's x-scope rule. Each row
// now includes ambiguousReason (one of the 5 codes, or null for pre-existing
// rows — see design doc) and conversationUrl (null if conversationKey has no
// recognizable LinkedIn thread slug).
// Query params: page? (default 1), limit? (10|25|50|100, default 10),
// sortBy? (resolvedAt|participantName, default resolvedAt),
// sortOrder? (asc|desc, default desc), search? (matches participant name or
// conversationKey, case-insensitive).
```

```typescript
// POST /api/owner-overrides/:conversationKey — body { ownerId, participantName? }.
// 409 if the conversation isn't currently 'ambiguous'. 400 if participantName
// is present but blank after trimming. Omitting participantName means no
// name change is attempted.
```

- [ ] **Step 5: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Manual verification — the full happy paths**

With the dev server running:

```bash
curl -s "http://localhost:<port>/api/owner-overrides?limit=10" \
  -H "x-api-key: <key>" -H "x-requester-email: <email>" -H "x-scope: all"
```

Expected: each row in `data.data[]` has `ambiguousReason` (a code string or `null`) and `conversationUrl` (a `https://www.linkedin.com/messaging/thread/...` URL or `null`), matching the spec's example response shape.

Then apply a real override with a name correction:

```bash
curl -s -X POST http://localhost:<port>/api/owner-overrides/<ambiguous-key> \
  -H "x-api-key: <key>" -H "x-requester-email: <email>" -H "Content-Type: application/json" \
  -d '{"ownerId":"<connected-owner-id>","participantName":"contact_a_b"}'
```

Expected: `200`, body `{ conversationKey, ownerId }` unchanged shape. Then confirm in the DB:

```sql
SELECT conversation_key, participant_name FROM message_activity WHERE conversation_key = '<ambiguous-key>';
SELECT ambiguous_reason, old_participant_name, new_participant_name FROM owner_override_audit WHERE conversation_key = '<ambiguous-key>' ORDER BY performed_at DESC LIMIT 1;
```

Expected: every `message_activity` row for that key now shows `participant_name = 'contact_a_b'`; the newest `owner_override_audit` row has the pre-override reason snapshotted, `old_participant_name` equal to whatever it was before, and `new_participant_name = 'contact_a_b'`.

Then apply an override WITHOUT `participantName` on a different `'ambiguous'` conversation and confirm its audit row's `new_participant_name` is `NULL` and `message_activity.participant_name` for that key is untouched.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/ownerOverrideController.ts
git commit -m "feat: surface ambiguousReason/conversationUrl, accept participantName"
```

---

### Task 7: Full manual verification pass

**Files:** none (verification only — no code changes).

**Interfaces:** none.

- [ ] **Step 1: Re-run `npx tsc --noEmit` and `npx prisma migrate status` from `backend/`**

Expected: no type errors; migration status "up to date".

- [ ] **Step 2: Walk the spec's Testing section end to end**

Using the real dev DB (per Global Constraints — no mocking in this repo):

1. Confirm `conversation_owner_cache.ambiguous_reason` is correctly populated for each of the 5 branches (if not already fully confirmed in Task 3 Step 3).
2. Apply an override with `participantName` — confirm every `message_activity` row for that `conversationKey` updated uniformly, and the audit row's `old_participant_name`/`new_participant_name` are correct (if not already fully confirmed in Task 6 Step 6).
3. Apply an override without `participantName` — confirm no name change, `new_participant_name` is `NULL` (if not already fully confirmed in Task 6 Step 6).
4. Attempt an override on a non-ambiguous conversation — confirm `409` (if not already fully confirmed in Task 5 Step 5).
5. Attempt an override with a blank `participantName` — confirm `400` (if not already fully confirmed in Task 5 Step 5).
6. Confirm `GET /api/owner-overrides` returns the right `ambiguousReason` and a correctly-formed `conversationUrl` (if not already fully confirmed in Task 6 Step 6).

- [ ] **Step 3: Confirm the pre-existing-rows non-goal holds**

```sql
SELECT conversation_key, ambiguous_reason FROM conversation_owner_cache
WHERE attribution_source = 'ambiguous' AND resolved_at < '2026-10-08';
```

Expected: every row from before this feature shipped still shows `ambiguous_reason = NULL` — confirms no accidental backfill happened.

- [ ] **Step 4: Final commit (if any fixups were needed)**

If Steps 1–3 required any code fixes, commit them individually with a descriptive message per fix before finishing. If nothing needed fixing, no commit here.
