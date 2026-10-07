# HubSpot Owner Attribution — Name-Match Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocked URN-based HubSpot owner-resolution strategy with an exact name match (`MessageActivity.participantName` vs HubSpot `firstname`/`lastname`), add a cached `'ambiguous'` outcome for anything a name match can't cleanly resolve, exclude those rows from the three message reports, and add a manual-override write path (with audit trail) for a human to resolve them.

**Architecture:** Swap the inner HubSpot lookup inside the existing `MessageOwnerResolverService` (cache-check → resolve → persist skeleton is unchanged) from a LinkedIn-handle search to a first/last-name search; widen `attributionSource` to a 4th/5th string value (`'ambiguous'`, `'manual'` — the column is plain `TEXT`, no enum migration needed); add one `AND attribution_source IS DISTINCT FROM 'ambiguous'` predicate to every report repository's raw SQL; add a new `OwnerOverrideAudit` table and a new, separately-routed `/api/owner-overrides` read/write API gated by the existing `requirePublicApiKey` shared secret plus a new header-trusting middleware.

**Tech Stack:** TypeScript / Express / Prisma / PostgreSQL (Supabase) / HubSpot CRM v3 Search API / axios.

**Spec:** `backend/docs/superpowers/specs/2026-10-07-hubspot-owner-attribution-name-match-design.md`

## Global Constraints

- Exact match only — case-insensitive, trimmed. No fuzzy/Levenshtein/soundex matching (spec non-goal).
- `message_events.attribution_source` / `conversation_owner_cache.attribution_source` are plain `TEXT` columns (confirmed in `prisma/schema.prisma` and the `20260901062531_add_message_owner_attribution` migration) — adding `'ambiguous'`/`'manual'` as values is an application-code change only, **no schema migration required** for the enum values themselves.
- `'ambiguous'` results ARE cached permanently in `conversation_owner_cache` (same as the existing permanent-fallback case) — re-checked only via an explicit manual override, never retried automatically. Only a genuine `transient: true` HubSpot/API failure is withheld from the cache.
- Raw `message_events` rows are never deleted or altered by report exclusion — the `'ambiguous'` filter is query-level only, in the report repositories.
- New endpoints live in a **new route file**, not `publicRoutes.ts` (its "no write endpoints" comment stays true for that file).
- `requirePublicApiKey` (existing shared-secret gate) runs first; a new middleware then reads `x-requester-email`/`x-scope` and trusts them fully — no second local admin allowlist, no DB-backed role check.
- The write endpoint gets its own `express-rate-limit` instance keyed by `x-requester-email` (pattern: `userAwareLimiter` in `src/middlewares/rateLimiter.ts`), not just the global IP limiter.
- Branch-setup (new branch off `dev`, cherry-picking the schema/resolver-skeleton/COALESCE wiring from `feature/hubspot-owner-attribution-spec`) is a controller/setup step, not one of the tasks below — the worktree this plan executes in already has that code present.
- **Ruling (not explicit in the spec's 6 enumerated resolver outcomes):** "exactly 1 name match, `hubspot_owner_id` is set, but no Techeniac `User` row has that `hubspotOwnerId`" (an owner exists in HubSpot but isn't connected/mapped in this app) is treated as `'ambiguous'`, not `'fallback'` — it is a permanent, cacheable fact about current data (same reasoning as spec's case "1 match, no owner"), and `'fallback'` is reserved for the transient API/connection-failure bucket. If this is wrong, the cost is: a resolvable-in-principle conversation sits on the needs-resolution list instead of being silently fallback-attributed to the scraper — strictly safer than the alternative, per Goal 2.

## File Structure

- `src/services/hubspotContactService.ts` — add `findContactOwnerIdByName` (new HubSpot search call).
- `src/services/hubspotSyncService.ts` — thin wrapper for the above (existing pattern).
- `src/services/messageOwnerResolverService.ts` — swap `resolveOwnerFromHubSpot`'s inner lookup; widen `AttributionSource`.
- `src/repositories/conversationOwnerCacheRepository.ts`, `src/repositories/messageEventRepository.ts` — widen `attributionSource` param types.
- `src/repositories/messageEventRepository.ts`, `src/repositories/lateMessageRepository.ts`, `src/repositories/missedFollowUpRepository.ts` — add the `'ambiguous'`-exclusion predicate to every report raw-SQL query.
- `prisma/schema.prisma` + new migration — `OwnerOverrideAudit` table only.
- `src/repositories/ownerOverrideRepository.ts` (new) — list-ambiguous + transactional override write.
- `src/services/ownerOverrideService.ts` (new) — scope rules, owner validation, orchestration.
- `src/middlewares/requesterContext.ts` (new) — `x-requester-email`/`x-scope` middleware.
- `src/middlewares/rateLimiter.ts` — add `overrideWriteLimiter`.
- `src/controllers/ownerOverrideController.ts` (new), `src/routes/ownerOverrideRoutes.ts` (new), `src/routes/index.ts` — mount `/api/owner-overrides`.
- Runbook task: reapply the live-DB migrations that were manually dropped, re-run the dedupe safety check.

## Review Focus

1. **Single-word participant name** ("Madonna", no space) — `lastName` becomes `""`; the name-match search must not silently match everything or throw. Pinned in Task 2.
2. **Override `ownerId` not in the live connected-owner set** — must be rejected (`ValidationError`), never silently written to `conversation_owner_cache`/`message_events`. Pinned in Task 6.
3. **`x-scope: regular` requester with no matching `User` row** (email not in this service's `User` table at all) — list/override must return empty / reject, never throw or leak every owner's conversations. Pinned in Task 6.
4. **Missing/invalid API key rejected before either header is read** — `requirePublicApiKey` must run, and fail, before `requireRequesterContext` ever touches `x-requester-email`/`x-scope`. Pinned in Task 7.
5. **Cached `'ambiguous'` conversation does not re-trigger a HubSpot call** on the next message for that conversation (same short-circuit the existing permanent-fallback case already relies on) — must still hold once `'ambiguous'` is a real cached value. Pinned in Task 2.

---

### Task 1: `HubSpotContactService.findContactOwnerIdByName`

**Files:**
- Modify: `backend/src/services/hubspotContactService.ts`
- Modify: `backend/src/services/hubspotSyncService.ts`

**Interfaces:**
- Produces: `HubSpotContactService.findContactOwnerIdByName(firstName: string, lastName: string): Promise<{ ownerId: string | null; matchCount: number }>` and `HubSpotSyncService.findContactOwnerIdByName(firstName: string, lastName: string)` (thin passthrough) — consumed by Task 2's resolver.

- [ ] **Step 1: Add the method to `HubSpotContactService`**

In `backend/src/services/hubspotContactService.ts`, add this method right after `findContactOwnerIdByProfileUrl` (after line 305):

```typescript
  /**
   * Exact (case-insensitive, trimmed) first+last name match against HubSpot
   * contacts, searched across all owners' contacts — same scope as
   * findContactOwnerIdByProfileUrl. HubSpot's search filters are tokenized,
   * so CONTAINS_TOKEN is used to fetch a candidate set, then exact equality
   * is re-checked client-side (same two-step pattern as
   * searchContactByUsername above) rather than trusting HubSpot's own
   * match semantics to be exact.
   *
   * matchCount distinguishes the three outcomes a caller needs: 0 (no
   * contact with this name), 1 (safe to use ownerId, which may itself be
   * null if the contact has no HubSpot owner), 2+ (collision — no signal
   * in captured data to disambiguate, caller must not guess).
   */
  async findContactOwnerIdByName(
    firstName: string,
    lastName: string,
  ): Promise<{ ownerId: string | null; matchCount: number }> {
    const fn = firstName.trim();
    const ln = lastName.trim();
    // A lone first name (no captured last name) has no safe HubSpot filter
    // to narrow on — searching by firstname alone would return every
    // contact sharing that first name. Treat as a guaranteed non-1 match
    // without ever calling HubSpot.
    if (!fn || !ln) return { ownerId: null, matchCount: fn || ln ? 2 : 0 };

    try {
      const response = await axios.post(
        `${this.baseUrl}/crm/v3/objects/contacts/search`,
        {
          filterGroups: [
            {
              filters: [
                { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: fn },
                { propertyName: "lastname", operator: "CONTAINS_TOKEN", value: ln },
              ],
            },
          ],
          properties: ["firstname", "lastname", "hubspot_owner_id"],
          limit: 10,
        },
        { headers: this.headers },
      );

      const results = response.data?.results ?? [];
      const matches = results.filter((contact: any) => {
        const cf = (contact.properties?.firstname || "").trim().toLowerCase();
        const cl = (contact.properties?.lastname || "").trim().toLowerCase();
        return cf === fn.toLowerCase() && cl === ln.toLowerCase();
      });

      if (matches.length !== 1) return { ownerId: null, matchCount: matches.length };
      return { ownerId: matches[0].properties?.hubspot_owner_id ?? null, matchCount: 1 };
    } catch (err: any) {
      if (err.response?.status === 404 || err.response?.status === 400) {
        return { ownerId: null, matchCount: 0 };
      }
      throw err;
    }
  }
```

- [ ] **Step 2: Wrap it in `HubSpotSyncService`**

In `backend/src/services/hubspotSyncService.ts`, add right after the existing `findContactOwnerIdByProfileUrl` wrapper:

```typescript
  findContactOwnerIdByName(firstName: string, lastName: string) {
    return this.contactService.findContactOwnerIdByName(firstName, lastName);
  }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit` from `backend/`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/hubspotContactService.ts src/services/hubspotSyncService.ts
git commit -m "feat: add HubSpot exact name-match contact lookup"
```

---

### Task 2: Resolver — swap to name-match, add `'ambiguous'`

**Files:**
- Modify: `backend/src/services/messageOwnerResolverService.ts`

**Interfaces:**
- Consumes: `HubSpotSyncService.findContactOwnerIdByName` (Task 1).
- Produces: `AttributionSource = "hubspot" | "fallback" | "ambiguous"` — consumed by Task 3 (repository type widening) and every report repository (Task 4 filters on the string value `'ambiguous'`).

- [ ] **Step 1: Widen `AttributionSource` and rewrite `resolveOwnerFromHubSpot`**

In `backend/src/services/messageOwnerResolverService.ts`, replace:

```typescript
export type AttributionSource = "hubspot" | "fallback";
```

with:

```typescript
export type AttributionSource = "hubspot" | "fallback" | "ambiguous";
```

Replace the entire `resolveOwnerFromHubSpot` method (lines 83–123) with:

```typescript
  private static async resolveOwnerFromHubSpot(
    conversationKey: string,
    scraperUserId: string,
  ): Promise<ResolvedOwner> {
    // The name LinkedIn already gives at message-sync time — see the design
    // doc: LinkedIn's message-thread data never carries a resolvable vanity
    // handle, so the URN-based lookup this used to do always missed. A
    // missing name is a genuine, permanent "can't resolve, and never will
    // from this data" case — deliberately outside the try/catch below (no
    // HubSpot call is even attempted).
    const activity = await prisma.messageActivity.findUnique({
      where: { userId_conversationKey: { userId: scraperUserId, conversationKey } },
      select: { participantName: true },
    });
    const name = activity?.participantName?.trim();
    if (!name) return { ownerId: null, source: "ambiguous" };

    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ");

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

    // 0 matches, 2+ matches, or exactly 1 match with no HubSpot owner set —
    // no disambiguation signal exists in captured data for any of these.
    if (match.matchCount !== 1 || !match.ownerId) {
      return { ownerId: null, source: "ambiguous" };
    }

    const user = await prisma.user.findFirst({
      where: { hubspotOwnerId: match.ownerId },
      select: { id: true },
    });
    // A real HubSpot owner exists but isn't a connected Techeniac user — not
    // a transient failure (HubSpot answered definitively), and not a
    // resolution either. See this plan's Global Constraints ruling.
    if (!user) return { ownerId: null, source: "ambiguous" };

    return { ownerId: user.id, source: "hubspot" };
  }
```

(`prisma`, `logger`, and `HubSpotContextService` are already imported at the top of this file; `extractLinkedInHandle` is no longer used by this method and its import can be removed if nothing else in the file references it.)

- [ ] **Step 2: Remove the now-unused `extractLinkedInHandle` import if applicable**

Run: `grep -n "extractLinkedInHandle" backend/src/services/messageOwnerResolverService.ts`
If the only remaining match is the `import` line itself, delete that import line.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit` from `backend/`
Expected: no errors (this step will fail until Task 3 widens the repository method signatures that `resolveAndPersist` passes `resolved.source`/`cached.attributionSource` into — if so, note it and proceed to Task 3 before re-running this check; do not weaken the type to work around it).

- [ ] **Step 4: Manual verification against the dev database**

This resolver has no HubSpot-independent unit-test harness in this codebase (no mocking library is installed; every existing resolver verification in this project has been done by hand against a real dev DB — see `docs/superpowers/STATUS-hubspot-owner-attribution.md`'s "17/17 test resolutions" note). Verify the same way:

1. Pick (or seed) a `message_activity` row with a `participantName` that has no space (e.g. `"Madonna"`) and confirm `MessageOwnerResolverService.resolveAndPersist` for its `conversationKey` ends in `attributionSource: 'ambiguous'`, `resolvedOwnerId: null` — and that no HubSpot call was attempted for the no-space case specifically (name has no `lastName`, so `matchCount` is forced to a non-1 value before any `axios` call).
2. Pick a conversation whose participant name matches exactly one HubSpot contact with a `hubspot_owner_id` that maps to a connected `User` — confirm it resolves to `attributionSource: 'hubspot'`, `resolvedOwnerId` set to that user's id.
3. Re-run `resolveAndPersist` a second time for the same `'ambiguous'` conversation from step 1 and confirm (via a temporary `console.log` or request log) that HubSpot is NOT called again — the `conversation_owner_cache` hit at the top of `resolveAndPersist` must short-circuit before `resolveOwnerFromHubSpot` runs, exactly as it already does for `'fallback'`.

- [ ] **Step 5: Commit**

```bash
git add src/services/messageOwnerResolverService.ts
git commit -m "feat: swap owner resolution from URN match to exact name match"
```

---

### Task 3: Widen `attributionSource` types in the cache/event repositories

**Files:**
- Modify: `backend/src/repositories/conversationOwnerCacheRepository.ts`
- Modify: `backend/src/repositories/messageEventRepository.ts:136-145`

**Interfaces:**
- Consumes: `AttributionSource` values produced by Task 2 (`'ambiguous'` now a real value passed into these methods).
- Produces: `ConversationOwnerCacheRepository.upsert(conversationKey, resolvedOwnerId, attributionSource: "hubspot" | "fallback" | "ambiguous" | "manual")`, `MessageEventRepository.updateResolvedOwner(conversationKey, resolvedOwnerId, attributionSource: "hubspot" | "fallback" | "ambiguous" | "manual")` — consumed by Task 2 (already written against the widened type) and Task 6's override write path (passes `'manual'`).

- [ ] **Step 1: Widen `ConversationOwnerCacheRepository.upsert`**

In `backend/src/repositories/conversationOwnerCacheRepository.ts`, replace:

```typescript
  static async upsert(
    conversationKey: string,
    resolvedOwnerId: string | null,
    attributionSource: "hubspot" | "fallback",
  ): Promise<void> {
```

with:

```typescript
  static async upsert(
    conversationKey: string,
    resolvedOwnerId: string | null,
    attributionSource: "hubspot" | "fallback" | "ambiguous" | "manual",
  ): Promise<void> {
```

- [ ] **Step 2: Widen `MessageEventRepository.updateResolvedOwner`**

In `backend/src/repositories/messageEventRepository.ts`, replace:

```typescript
  static async updateResolvedOwner(
    conversationKey: string,
    resolvedOwnerId: string | null,
    attributionSource: "hubspot" | "fallback",
  ): Promise<void> {
```

with:

```typescript
  static async updateResolvedOwner(
    conversationKey: string,
    resolvedOwnerId: string | null,
    attributionSource: "hubspot" | "fallback" | "ambiguous" | "manual",
  ): Promise<void> {
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit` from `backend/`
Expected: no errors — this should also clear any error left over from Task 2 Step 3.

- [ ] **Step 4: Commit**

```bash
git add src/repositories/conversationOwnerCacheRepository.ts src/repositories/messageEventRepository.ts
git commit -m "feat: widen attributionSource type to include ambiguous/manual"
```

---

### Task 4: Report layer — exclude `'ambiguous'` rows

**Files:**
- Modify: `backend/src/repositories/messageEventRepository.ts`
- Modify: `backend/src/repositories/lateMessageRepository.ts`
- Modify: `backend/src/repositories/missedFollowUpRepository.ts`

**Interfaces:**
- No signature changes — same exported methods, same callers (`MessageEventService`, `LateMessageService`, `MissedFollowUpService` are untouched by this task).

- [ ] **Step 1: `messageEventRepository.ts` — add the shared exclusion fragment**

Add this constant right after the existing `accountFilterSql` function (after line 69):

```typescript
// Every report query must exclude 'ambiguous' rows (Goal 2 of the design
// doc: an unresolved conversation is excluded from reports, not miscredited
// to the scraper) — but NOT the useRawScraperId popup counter (GET
// /api/messages/stats/today), which isn't one of the three reports and must
// keep reflecting the calling scraper's own raw activity regardless of
// resolution state. IS DISTINCT FROM (not != ) so a NULL attribution_source
// (not yet resolved) still passes through, same as every other row.
const AMBIGUOUS_EXCLUSION = Prisma.sql`AND attribution_source IS DISTINCT FROM 'ambiguous'`;
const ambiguousFilterSql = (opts: Pick<SeriesFilterOpts, "useRawScraperId">) =>
  opts.useRawScraperId ? Prisma.empty : AMBIGUOUS_EXCLUSION;
```

- [ ] **Step 2: Apply it to `getSeries`**

In `getSeries` (around line 158-175), replace:

```typescript
    const bucket = bucketOf(opts.granularity);
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
      GROUP BY 1
      ORDER BY 1
    `;
```

with:

```typescript
    const bucket = bucketOf(opts.granularity);
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);
    const ambiguousFilter = ambiguousFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
        ${ambiguousFilter}
      GROUP BY 1
      ORDER BY 1
    `;
```

- [ ] **Step 3: Apply it to `getSeriesByOwner`**

Replace:

```typescript
    const bucket = bucketOf(opts.granularity);
    const accountFilter = accountFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COALESCE(resolved_owner_id, user_id) AS "userId",
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND COALESCE(resolved_owner_id, user_id) = ANY(${ownerIds})
        ${accountFilter}
      GROUP BY 1, COALESCE(resolved_owner_id, user_id)
      ORDER BY 1
    `;
```

with:

```typescript
    const bucket = bucketOf(opts.granularity);
    const accountFilter = accountFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COALESCE(resolved_owner_id, user_id) AS "userId",
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND COALESCE(resolved_owner_id, user_id) = ANY(${ownerIds})
        AND attribution_source IS DISTINCT FROM 'ambiguous'
        ${accountFilter}
      GROUP BY 1, COALESCE(resolved_owner_id, user_id)
      ORDER BY 1
    `;
```

- [ ] **Step 4: Apply it to `getSeriesByOwnerAccount`**

Replace:

```typescript
    const bucket = bucketOf(opts.granularity);
    const accountFilter = accountFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COALESCE(resolved_owner_id, user_id) AS "userId",
             self_linkedin_id AS "accountId",
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND COALESCE(resolved_owner_id, user_id) = ANY(${ownerIds})
        ${accountFilter}
      GROUP BY 1, COALESCE(resolved_owner_id, user_id), self_linkedin_id
      ORDER BY 1
    `;
```

with:

```typescript
    const bucket = bucketOf(opts.granularity);
    const accountFilter = accountFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COALESCE(resolved_owner_id, user_id) AS "userId",
             self_linkedin_id AS "accountId",
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND COALESCE(resolved_owner_id, user_id) = ANY(${ownerIds})
        AND attribution_source IS DISTINCT FROM 'ambiguous'
        ${accountFilter}
      GROUP BY 1, COALESCE(resolved_owner_id, user_id), self_linkedin_id
      ORDER BY 1
    `;
```

- [ ] **Step 5: Apply it to `getTotals`**

Replace:

```typescript
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);

    const rows = await prisma.$queryRaw<
      Array<{ fresh: number; followups: number; sent: number; received: number; replied: number }>
    >`
      SELECT COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
    `;
```

with:

```typescript
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);
    const ambiguousFilter = ambiguousFilterSql(opts);

    const rows = await prisma.$queryRaw<
      Array<{ fresh: number; followups: number; sent: number; received: number; replied: number }>
    >`
      SELECT COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
        ${ambiguousFilter}
    `;
```

- [ ] **Step 6: Apply it to `findQualifyingEvents`**

Replace:

```typescript
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);

    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        display_owner_id: string;
        conversation_key: string;
        occurred_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
        kind: "FRESH" | "FOLLOW_UP" | "REPLIED";
      }>
    >`
      SELECT user_id, COALESCE(resolved_owner_id, user_id) AS display_owner_id,
             conversation_key, occurred_at,
             participant_linkedin_id, self_linkedin_id,
             CASE
               WHEN type = 'SENT' AND is_first_touch THEN 'FRESH'
               WHEN type = 'SENT' AND is_follow_up THEN 'FOLLOW_UP'
               ELSE 'REPLIED'
             END AS kind
      FROM message_events
      WHERE (
        (type = 'SENT' AND is_first_touch)
        OR (type = 'SENT' AND is_follow_up)
        OR (type = 'RECEIVED' AND is_first_reply)
      )
      AND occurred_at >= ${from} AND occurred_at <= ${to}
      ${ownerFilter}
      ${accountFilter}
    `;
```

with:

```typescript
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);
    const ambiguousFilter = ambiguousFilterSql(opts);

    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        display_owner_id: string;
        conversation_key: string;
        occurred_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
        kind: "FRESH" | "FOLLOW_UP" | "REPLIED";
      }>
    >`
      SELECT user_id, COALESCE(resolved_owner_id, user_id) AS display_owner_id,
             conversation_key, occurred_at,
             participant_linkedin_id, self_linkedin_id,
             CASE
               WHEN type = 'SENT' AND is_first_touch THEN 'FRESH'
               WHEN type = 'SENT' AND is_follow_up THEN 'FOLLOW_UP'
               ELSE 'REPLIED'
             END AS kind
      FROM message_events
      WHERE (
        (type = 'SENT' AND is_first_touch)
        OR (type = 'SENT' AND is_follow_up)
        OR (type = 'RECEIVED' AND is_first_reply)
      )
      AND occurred_at >= ${from} AND occurred_at <= ${to}
      ${ownerFilter}
      ${accountFilter}
      ${ambiguousFilter}
    `;
```

- [ ] **Step 7: `lateMessageRepository.ts` — `findSentReplyCandidates`**

Replace:

```typescript
    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        display_owner_id: string;
        conversation_key: string;
        occurred_at: Date;
        responds_to_at: Date | null;
        self_time_zone: string | null;
        is_follow_up: boolean;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
      }>
    >`
      SELECT user_id, COALESCE(resolved_owner_id, user_id) AS display_owner_id,
             conversation_key, occurred_at, responds_to_at, self_time_zone,
             is_follow_up, participant_linkedin_id, self_linkedin_id
      FROM message_events
      WHERE type = 'SENT'
        AND is_follow_up = false
        AND responds_to_at IS NOT NULL
        AND occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
    `;
```

with:

```typescript
    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        display_owner_id: string;
        conversation_key: string;
        occurred_at: Date;
        responds_to_at: Date | null;
        self_time_zone: string | null;
        is_follow_up: boolean;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
      }>
    >`
      SELECT user_id, COALESCE(resolved_owner_id, user_id) AS display_owner_id,
             conversation_key, occurred_at, responds_to_at, self_time_zone,
             is_follow_up, participant_linkedin_id, self_linkedin_id
      FROM message_events
      WHERE type = 'SENT'
        AND is_follow_up = false
        AND responds_to_at IS NOT NULL
        AND occurred_at >= ${from} AND occurred_at <= ${to}
        AND attribution_source IS DISTINCT FROM 'ambiguous'
        ${ownerFilter}
        ${accountFilter}
    `;
```

- [ ] **Step 8: `lateMessageRepository.ts` — `queryLateFollowUps`**

Replace:

```typescript
    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        display_owner_id: string;
        conversation_key: string;
        occurred_at: Date;
        responds_to_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
      }>
    >`
      SELECT user_id, COALESCE(resolved_owner_id, user_id) AS display_owner_id,
             conversation_key, occurred_at, responds_to_at,
             participant_linkedin_id, self_linkedin_id
      FROM message_events
      WHERE is_follow_up = true
        AND responds_to_at IS NOT NULL
        AND occurred_at > responds_to_at + (${LATE_FOLLOWUP_THRESHOLD_DAYS} * INTERVAL '1 day')
        ${boundFilter}
        ${ownerFilter}
        ${accountFilter}
    `;
```

with:

```typescript
    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        display_owner_id: string;
        conversation_key: string;
        occurred_at: Date;
        responds_to_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
      }>
    >`
      SELECT user_id, COALESCE(resolved_owner_id, user_id) AS display_owner_id,
             conversation_key, occurred_at, responds_to_at,
             participant_linkedin_id, self_linkedin_id
      FROM message_events
      WHERE is_follow_up = true
        AND responds_to_at IS NOT NULL
        AND occurred_at > responds_to_at + (${LATE_FOLLOWUP_THRESHOLD_DAYS} * INTERVAL '1 day')
        AND attribution_source IS DISTINCT FROM 'ambiguous'
        ${boundFilter}
        ${ownerFilter}
        ${accountFilter}
    `;
```

- [ ] **Step 9: `missedFollowUpRepository.ts` — `findLastEventPerConversation`**

Replace:

```typescript
    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        display_owner_id: string;
        conversation_key: string;
        type: "SENT" | "RECEIVED";
        occurred_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
      }>
    >`
      SELECT DISTINCT ON (COALESCE(resolved_owner_id, user_id), conversation_key)
        user_id, COALESCE(resolved_owner_id, user_id) AS display_owner_id,
        conversation_key, type, occurred_at,
        participant_linkedin_id, self_linkedin_id
      FROM message_events
      WHERE true ${ownerFilter} ${accountFilter}
      ORDER BY COALESCE(resolved_owner_id, user_id), conversation_key, occurred_at DESC, (type = 'RECEIVED') DESC
    `;
```

with:

```typescript
    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        display_owner_id: string;
        conversation_key: string;
        type: "SENT" | "RECEIVED";
        occurred_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
      }>
    >`
      SELECT DISTINCT ON (COALESCE(resolved_owner_id, user_id), conversation_key)
        user_id, COALESCE(resolved_owner_id, user_id) AS display_owner_id,
        conversation_key, type, occurred_at,
        participant_linkedin_id, self_linkedin_id
      FROM message_events
      WHERE attribution_source IS DISTINCT FROM 'ambiguous' ${ownerFilter} ${accountFilter}
      ORDER BY COALESCE(resolved_owner_id, user_id), conversation_key, occurred_at DESC, (type = 'RECEIVED') DESC
    `;
```

Note: this changes `WHERE true ${ownerFilter}...` to `WHERE attribution_source IS DISTINCT FROM 'ambiguous' ${ownerFilter}...` — the leading `true` was only ever a syntactic placeholder for "always true, filters appended via `AND`"; the new leading predicate serves the identical syntactic role.

- [ ] **Step 10: Verify it compiles**

Run: `npx tsc --noEmit` from `backend/`
Expected: no errors.

- [ ] **Step 11: Manual verification against the dev database**

Using the `'ambiguous'` conversation created in Task 2 Step 4.1: confirm it does NOT appear in `MessageEventService.getSeries`/`getTotals`/`list` output, `LateMessageService` output, or `MissedFollowUpService` output for a window covering its `occurredAt`, while a `'hubspot'`-resolved or raw-`'fallback'` conversation in the same window still appears as before. Also confirm `GET /api/messages/stats/today` (the `useRawScraperId: true` call site) is unaffected — hit it for the scraper that owns the `'ambiguous'` conversation's events and confirm today's count still includes them (that endpoint never filters by resolution state).

- [ ] **Step 12: Commit**

```bash
git add src/repositories/messageEventRepository.ts src/repositories/lateMessageRepository.ts src/repositories/missedFollowUpRepository.ts
git commit -m "feat: exclude ambiguous-attribution rows from report queries"
```

---

### Task 5: `OwnerOverrideAudit` schema + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20261007120000_add_owner_override_audit/migration.sql`

**Interfaces:**
- Produces: Prisma model `OwnerOverrideAudit` (fields: `id`, `conversationKey`, `oldOwnerId`, `newOwnerId`, `performedByEmail`, `performedAt`) — consumed by Task 6's `OwnerOverrideRepository.applyOverride`.

- [ ] **Step 1: Add the model**

In `backend/prisma/schema.prisma`, add after the `ConversationOwnerCache` model (after line 330):

```prisma
// Append-only audit trail for manual owner overrides (see
// docs/superpowers/specs/2026-10-07-hubspot-owner-attribution-name-match-design.md).
// Insert-only — a conversation_owner_cache upsert alone would silently lose
// who performed a PRIOR override once a later one overwrites it.
// performedByEmail is a plain string (the trusted x-requester-email header),
// not a User FK: the human performing the override may not be a row in this
// service's own User table (see the design doc's auth-model correction).
// newOwnerId/oldOwnerId are plain strings too, not User FKs, for the same
// reason the FK on this table is deliberately omitted — this table only
// ever needs to record what happened, not enforce it.
model OwnerOverrideAudit {
  id               String   @id @default(uuid())
  conversationKey  String   @map("conversation_key")
  oldOwnerId       String?  @map("old_owner_id")
  newOwnerId       String   @map("new_owner_id")
  performedByEmail String   @map("performed_by_email")
  performedAt      DateTime @default(now()) @map("performed_at")

  @@index([conversationKey])
  @@map("owner_override_audit")
}
```

- [ ] **Step 2: Write the migration**

Create `backend/prisma/migrations/20261007120000_add_owner_override_audit/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "owner_override_audit" (
    "id" TEXT NOT NULL,
    "conversation_key" TEXT NOT NULL,
    "old_owner_id" TEXT,
    "new_owner_id" TEXT NOT NULL,
    "performed_by_email" TEXT NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_override_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_override_audit_conversation_key_idx" ON "owner_override_audit"("conversation_key");
```

- [ ] **Step 3: Apply it against the dev database and regenerate the client**

```bash
npx prisma migrate dev --name add_owner_override_audit
```

Expected: if the migration file from Step 2 already exists on disk with the chosen name, Prisma will detect it's already applied/pending and either apply it directly or report it as already present — either way, confirm `npx prisma migrate status` ends with "Database schema is up to date!" and `npx prisma generate` has run (migrate dev does this automatically).

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit` from `backend/`
Expected: no errors (confirms the generated Prisma client now has `prisma.ownerOverrideAudit`).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add OwnerOverrideAudit table"
```

---

### Task 6: `OwnerOverrideRepository` + `OwnerOverrideService`

**Files:**
- Create: `backend/src/repositories/ownerOverrideRepository.ts`
- Create: `backend/src/services/ownerOverrideService.ts`

**Interfaces:**
- Consumes: `ConversationOwnerCache`/`MessageEvent`/`OwnerOverrideAudit` Prisma models (Task 5), `getConnectedOwnerIds` (`src/services/hubspotOwnersService.ts`, existing).
- Produces: `OwnerOverrideService.listAmbiguous(params: { requesterEmail: string; scope: "regular" | "all" }): Promise<AmbiguousConversationDTO[]>` and `OwnerOverrideService.applyOverride(params: { conversationKey: string; newOwnerId: string; requesterEmail: string; scope: "regular" | "all" }): Promise<void>` — consumed by Task 8's controller.

- [ ] **Step 1: Write `OwnerOverrideRepository`**

Create `backend/src/repositories/ownerOverrideRepository.ts`:

```typescript
// src/repositories/ownerOverrideRepository.ts
//
// Data-access layer for the manual owner-override write path. See the
// design doc for the full reasoning:
// docs/superpowers/specs/2026-10-07-hubspot-owner-attribution-name-match-design.md
import prisma from "../config/prisma";

export interface AmbiguousConversation {
  conversationKey: string;
  resolvedAt: Date;
}

export class OwnerOverrideRepository {
  /**
   * Every conversation currently cached as 'ambiguous'. When scraperUserId
   * is given, narrowed to conversations where that scraper recorded at
   * least one message_events row for the conversation — the shared-
   * LinkedIn-account reality that any scraper who touched a conversation can
   * resolve it (see the design doc's GET /api/owner-overrides scope rule).
   */
  static async listAmbiguous(scraperUserId?: string): Promise<AmbiguousConversation[]> {
    if (scraperUserId) {
      return prisma.$queryRaw<AmbiguousConversation[]>`
        SELECT c.conversation_key AS "conversationKey", c.resolved_at AS "resolvedAt"
        FROM conversation_owner_cache c
        WHERE c.attribution_source = 'ambiguous'
          AND EXISTS (
            SELECT 1 FROM message_events m
            WHERE m.conversation_key = c.conversation_key AND m.user_id = ${scraperUserId}
          )
        ORDER BY c.resolved_at DESC
      `;
    }
    return prisma.$queryRaw<AmbiguousConversation[]>`
      SELECT conversation_key AS "conversationKey", resolved_at AS "resolvedAt"
      FROM conversation_owner_cache
      WHERE attribution_source = 'ambiguous'
      ORDER BY resolved_at DESC
    `;
  }

  /** Participant display name for a batch of conversationKeys, best-effort
   * (null if no message_activity row has ever captured one) — so a human
   * resolving the needs-resolution list can identify who they're picking an
   * owner for. */
  static async findParticipantNames(conversationKeys: string[]): Promise<Map<string, string | null>> {
    if (conversationKeys.length === 0) return new Map();
    const activities = await prisma.messageActivity.findMany({
      where: { conversationKey: { in: conversationKeys } },
      select: { conversationKey: true, participantName: true },
    });
    const nameByKey = new Map<string, string | null>();
    for (const a of activities) {
      if (!nameByKey.has(a.conversationKey) || (!nameByKey.get(a.conversationKey) && a.participantName)) {
        nameByKey.set(a.conversationKey, a.participantName);
      }
    }
    return nameByKey;
  }

  static async findCachedOwner(conversationKey: string): Promise<{ resolvedOwnerId: string | null } | null> {
    return prisma.conversationOwnerCache.findUnique({
      where: { conversationKey },
      select: { resolvedOwnerId: true },
    });
  }

  static async isScraperOfConversation(conversationKey: string, scraperUserId: string): Promise<boolean> {
    const row = await prisma.messageEvent.findFirst({
      where: { conversationKey, userId: scraperUserId },
      select: { conversationKey: true },
    });
    return row !== null;
  }

  /**
   * Applies a manual owner override atomically: upserts the cache row to
   * 'manual', re-stamps EVERY message_events row for this conversation (its
   * full history, not just new rows — see design doc Goal 3), and inserts an
   * audit row — all in one transaction so a crash mid-write can never leave
   * the cache, the event rows, and the audit trail disagreeing.
   */
  static async applyOverride(params: {
    conversationKey: string;
    oldOwnerId: string | null;
    newOwnerId: string;
    performedByEmail: string;
  }): Promise<void> {
    const { conversationKey, oldOwnerId, newOwnerId, performedByEmail } = params;
    await prisma.$transaction([
      prisma.conversationOwnerCache.upsert({
        where: { conversationKey },
        create: { conversationKey, resolvedOwnerId: newOwnerId, attributionSource: "manual" },
        update: { resolvedOwnerId: newOwnerId, attributionSource: "manual", resolvedAt: new Date() },
      }),
      prisma.messageEvent.updateMany({
        where: { conversationKey },
        data: { resolvedOwnerId: newOwnerId, attributionSource: "manual" },
      }),
      prisma.ownerOverrideAudit.create({
        data: { conversationKey, oldOwnerId, newOwnerId, performedByEmail },
      }),
    ]);
  }
}
```

- [ ] **Step 2: Write `OwnerOverrideService`**

Create `backend/src/services/ownerOverrideService.ts`:

```typescript
// src/services/ownerOverrideService.ts
//
// Business rules for the manual owner-override path: scope enforcement
// (who can see/resolve which ambiguous conversations), owner validation
// (must be a live HubSpot-connected owner), and orchestration of the
// repository's atomic write. See the design doc's Auth section for why
// x-requester-email is trusted fully once requirePublicApiKey has passed,
// and why there is no local admin allowlist here.
import prisma from "../config/prisma";
import { OwnerOverrideRepository } from "../repositories/ownerOverrideRepository";
import { getConnectedOwnerIds } from "./hubspotOwnersService";
import { ValidationError, ForbiddenError } from "../errors/AppError";

export type RequesterScope = "regular" | "all";

export interface AmbiguousConversationDTO {
  conversationKey: string;
  participantName: string | null;
  resolvedAt: Date;
}

export class OwnerOverrideService {
  // The requester's email may not correspond to any row in this service's
  // own User table (see design doc) — that's expected, not an error; it
  // just means a 'regular'-scope request from that requester can never
  // match any conversation (they've never been recorded as a scraper here).
  private static async resolveScraperUserId(requesterEmail: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { email: requesterEmail }, select: { id: true } });
    return user?.id ?? null;
  }

  static async listAmbiguous(params: {
    requesterEmail: string;
    scope: RequesterScope;
  }): Promise<AmbiguousConversationDTO[]> {
    let rows;
    if (params.scope === "all") {
      rows = await OwnerOverrideRepository.listAmbiguous();
    } else {
      const scraperUserId = await this.resolveScraperUserId(params.requesterEmail);
      rows = scraperUserId ? await OwnerOverrideRepository.listAmbiguous(scraperUserId) : [];
    }

    const nameByKey = await OwnerOverrideRepository.findParticipantNames(rows.map(r => r.conversationKey));
    return rows.map(r => ({
      conversationKey: r.conversationKey,
      participantName: nameByKey.get(r.conversationKey) ?? null,
      resolvedAt: r.resolvedAt,
    }));
  }

  static async applyOverride(params: {
    conversationKey: string;
    newOwnerId: string;
    requesterEmail: string;
    scope: RequesterScope;
  }): Promise<void> {
    const connectedIds = await getConnectedOwnerIds();
    if (!connectedIds.includes(params.newOwnerId)) {
      throw new ValidationError("ownerId must be a HubSpot-connected owner");
    }

    if (params.scope === "regular") {
      const scraperUserId = await this.resolveScraperUserId(params.requesterEmail);
      const isScraper = scraperUserId
        ? await OwnerOverrideRepository.isScraperOfConversation(params.conversationKey, scraperUserId)
        : false;
      if (!isScraper) {
        throw new ForbiddenError("Not authorized to override this conversation");
      }
    }

    const cached = await OwnerOverrideRepository.findCachedOwner(params.conversationKey);
    await OwnerOverrideRepository.applyOverride({
      conversationKey: params.conversationKey,
      oldOwnerId: cached?.resolvedOwnerId ?? null,
      newOwnerId: params.newOwnerId,
      performedByEmail: params.requesterEmail,
    });
  }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit` from `backend/`
Expected: no errors.

- [ ] **Step 4: Manual verification against the dev database**

1. Call `OwnerOverrideService.applyOverride` (e.g. via a throwaway `ts-node -e` one-liner, or temporarily from a test route) with a `newOwnerId` that is NOT in `getConnectedOwnerIds()` — confirm it throws `ValidationError` and neither `conversation_owner_cache` nor `message_events` nor `owner_override_audit` is touched (Review Focus item 2).
2. Call `listAmbiguous` with `scope: "regular"` and a `requesterEmail` for which no `User` row exists — confirm it returns `[]`, not a thrown error (Review Focus item 3).
3. Call `applyOverride` for the `'ambiguous'` conversation from Task 2/4's manual verification with a real connected owner id and `scope: "all"` — confirm `conversation_owner_cache.attributionSource` becomes `'manual'`, every `message_events` row for that `conversationKey` is re-stamped, and exactly one `owner_override_audit` row is inserted with the right `oldOwnerId`/`newOwnerId`/`performedByEmail`. Then re-run the Task 4 report queries and confirm this conversation now appears under the new owner, including its prior history.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/ownerOverrideRepository.ts src/services/ownerOverrideService.ts
git commit -m "feat: add owner-override repository and service"
```

---

### Task 7: `requesterContext` middleware + write-endpoint rate limiter

**Files:**
- Create: `backend/src/middlewares/requesterContext.ts`
- Modify: `backend/src/middlewares/rateLimiter.ts`

**Interfaces:**
- Produces: `RequesterRequest` type (extends `Request` with `requesterEmail?: string`, `requesterScope?: "regular" | "all"`), `requireRequesterContext` middleware, `overrideWriteLimiter` — consumed by Task 8's routes.

- [ ] **Step 1: Write the middleware**

Create `backend/src/middlewares/requesterContext.ts`:

```typescript
// src/middlewares/requesterContext.ts
//
// Reads x-requester-email / x-scope off a request that has already cleared
// requirePublicApiKey, and trusts them fully — no second local admin
// allowlist. See the design doc's Auth section: the shared API key IS the
// real trust boundary (only the calling service holds it); a local
// admin-email list would just be a second source of truth to keep in sync.
// Mount AFTER requirePublicApiKey on every router that uses this.
import { Request, Response, NextFunction } from "express";
import { ValidationError } from "../errors/AppError";

export type RequesterScope = "regular" | "all";

export interface RequesterRequest extends Request {
  requesterEmail?: string;
  requesterScope?: RequesterScope;
}

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export const requireRequesterContext = (
  req: RequesterRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const email = firstHeader(req.headers["x-requester-email"])?.trim();
  if (!email) {
    return next(new ValidationError("Missing x-requester-email header"));
  }

  const scopeRaw = firstHeader(req.headers["x-scope"]);
  req.requesterEmail = email;
  req.requesterScope = scopeRaw === "all" ? "all" : "regular";
  next();
};
```

- [ ] **Step 2: Add the rate limiter**

In `backend/src/middlewares/rateLimiter.ts`, add after `userAwareLimiter` (after line 89), and add the import at the top:

```typescript
import { RequesterRequest } from "./requesterContext";
```

```typescript
/**
 * Per-requester limiter for the owner-override write endpoint. Keyed by
 * x-requester-email (set by requireRequesterContext — mount this limiter
 * AFTER that middleware) rather than req.user, since this router has no
 * JWT-authenticated user. Deliberately tighter than userAwareLimiter: this
 * is a low-volume manual-correction action, not a regular polling endpoint.
 */
export const overrideWriteLimiter = rateLimit({
  ...shared,
  store: createRateLimitStore("rl:owner-override:"),
  max: 30,
  keyGenerator: (req: RequesterRequest) => req.requesterEmail ?? ipKey(req.ip),
  message: "Too many owner-override attempts, please slow down",
});
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit` from `backend/`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/middlewares/requesterContext.ts src/middlewares/rateLimiter.ts
git commit -m "feat: add requester-context middleware and owner-override rate limiter"
```

---

### Task 8: Controller + routes — `GET`/`POST /api/owner-overrides`

**Files:**
- Create: `backend/src/controllers/ownerOverrideController.ts`
- Create: `backend/src/routes/ownerOverrideRoutes.ts`
- Modify: `backend/src/routes/index.ts`

**Interfaces:**
- Consumes: `OwnerOverrideService` (Task 6), `requireRequesterContext`/`overrideWriteLimiter` (Task 7), `requirePublicApiKey` (existing).

- [ ] **Step 1: Write the controller**

Create `backend/src/controllers/ownerOverrideController.ts`:

```typescript
// src/controllers/ownerOverrideController.ts
import { Response, NextFunction } from "express";
import { RequesterRequest } from "../middlewares/requesterContext";
import { OwnerOverrideService } from "../services/ownerOverrideService";
import { ValidationError } from "../errors/AppError";
import { successResponse } from "../utils/apiResponse";

// GET /api/owner-overrides — every conversation currently needing a manual
// resolution, scoped per requireRequesterContext's x-scope rule.
export const listOwnerOverrides = async (
  req: RequesterRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await OwnerOverrideService.listAmbiguous({
      requesterEmail: req.requesterEmail!,
      scope: req.requesterScope!,
    });
    successResponse(res, { data }, "Ambiguous conversations retrieved");
  } catch (error) {
    next(error);
  }
};

// POST /api/owner-overrides/:conversationKey — body { ownerId }.
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

    await OwnerOverrideService.applyOverride({
      conversationKey,
      newOwnerId: ownerId,
      requesterEmail: req.requesterEmail!,
      scope: req.requesterScope!,
    });
    successResponse(res, { conversationKey, ownerId }, "Owner override applied");
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 2: Write the routes**

Create `backend/src/routes/ownerOverrideRoutes.ts`:

```typescript
// src/routes/ownerOverrideRoutes.ts
//
// Write-capable router for the manual owner-override path — deliberately
// NOT publicRoutes.ts (its "no write endpoints" comment stays true for that
// file). requirePublicApiKey gates it exactly as it gates the public reads;
// requireRequesterContext MUST run after it, not before, so a request
// missing/failing the API key is rejected before either header is read.
import { Router } from "express";
import { requirePublicApiKey } from "../middlewares/publicApiKey";
import { requireRequesterContext } from "../middlewares/requesterContext";
import { overrideWriteLimiter } from "../middlewares/rateLimiter";
import { listOwnerOverrides, applyOwnerOverride } from "../controllers/ownerOverrideController";

const router = Router();

router.use(requirePublicApiKey);
router.use(requireRequesterContext);

router.get("/", listOwnerOverrides);
router.post("/:conversationKey", overrideWriteLimiter, applyOwnerOverride);

export default router;
```

- [ ] **Step 3: Mount it**

In `backend/src/routes/index.ts`, add the import:

```typescript
import ownerOverrideRoutes from "./ownerOverrideRoutes";
```

and mount it after the `publicRoutes` line:

```typescript
router.use("/public", publicRoutes);
router.use("/owner-overrides", ownerOverrideRoutes);
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit` from `backend/`
Expected: no errors.

- [ ] **Step 5: Manual verification against the dev server**

Start the dev server (`npm run dev`), then:

1. `GET /api/owner-overrides` with no `x-api-key`/`Authorization` header (and `PUBLIC_API_KEY` set in the dev `.env`) → expect `401 Unauthorized`, and confirm (e.g. via a temporary log line in `requireRequesterContext`) that it never ran — Review Focus item 4.
2. `GET /api/owner-overrides` with a valid API key but no `x-requester-email` → expect `400` "Missing x-requester-email header".
3. `GET /api/owner-overrides` with a valid API key, `x-requester-email` set to the scraper used in Task 6's manual verification, no `x-scope` (defaults to `regular`) → expect the `'ambiguous'` conversation(s) that scraper touched, with `participantName` populated.
4. `POST /api/owner-overrides/<conversationKey>` with `{ "ownerId": "<a connected owner id>" }`, valid API key, `x-requester-email` set to a connected owner's own email, `x-scope: all` → expect `200` and the conversation to disappear from a subsequent `GET /api/owner-overrides` call.
5. Repeat the same `POST` with an `ownerId` not in the connected set → expect `400`.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/ownerOverrideController.ts src/routes/ownerOverrideRoutes.ts src/routes/index.ts
git commit -m "feat: add GET/POST /api/owner-overrides endpoints"
```

---

### Task 9: Reapply the live-DB attribution schema + dedupe safety re-run (runbook)

This task is an operational runbook, not application code — it brings whichever database this worktree's `DATABASE_URL`/`DIRECT_URL` point at back in sync with the migrations already on disk (dropped manually when the original branch paused, per `docs/superpowers/STATUS-hubspot-owner-attribution.md`). It must run AFTER Tasks 1–8 are merged/deployed to that environment, and does not itself touch application code.

**Files:**
- None (database state + verification only). Task 5's new migration (`20261007120000_add_owner_override_audit`) is unaffected by this task — it was never part of the original drop.

- [ ] **Step 1: Confirm the drift**

```bash
npx prisma migrate status
```

Expected: Prisma reports the three attribution migrations (`20260901062531_add_message_owner_attribution`, `20260901120000_relax_message_event_unique_constraint`, `20260902000000_add_message_event_effective_owner_indexes`) as already applied in its migration history table — while the actual tables/columns/constraint/indexes they created are absent from the live schema (manually dropped). This mismatch is exactly why a plain `prisma migrate deploy` will NOT recreate them (Prisma skips migrations it believes are already applied).

- [ ] **Step 2: Mark the three migrations rolled back**

```bash
npx prisma migrate resolve --rolled-back 20260901062531_add_message_owner_attribution
npx prisma migrate resolve --rolled-back 20260901120000_relax_message_event_unique_constraint
npx prisma migrate resolve --rolled-back 20260902000000_add_message_event_effective_owner_indexes
```

Expected: each command confirms the migration is now recorded as rolled back.

- [ ] **Step 3: Re-run the dedupe safety check BEFORE reapplying the unique-constraint migration**

Per the design doc: confirm the original merge (1125 duplicate groups / 2069 rows) is still intact and the dry run finds nothing new, before the relaxed-constraint migration goes back on.

```bash
npm run dedupe:message-events
```

Expected: dry-run output reports 0 new duplicate groups found (the script is idempotent — see its own header comment). If it reports any, STOP — do not proceed to Step 4 until investigated; re-running `-- --apply` is only appropriate if genuinely new duplicates have appeared since the original merge, which the design doc does not expect.

- [ ] **Step 4: Reapply all pending migrations**

```bash
npx prisma migrate deploy
```

Expected: the three rolled-back migrations (now pending again) apply cleanly — `conversation_owner_cache` table, `message_events.resolved_owner_id`/`attribution_source` columns, the relaxed `@@unique([conversationKey, messageId])` constraint, and the two effective-owner expression indexes are all recreated. `npx prisma migrate status` now reports "Database schema is up to date!".

- [ ] **Step 5: Spot-check the schema directly**

```bash
npx prisma studio
```

Confirm `conversation_owner_cache` exists and is empty (or holds only rows written by this plan's own manual verification steps), and that `message_events` has `resolved_owner_id`/`attribution_source` columns.

- [ ] **Step 6: No commit**

This task changes database state, not files under version control — there is nothing to `git add`/`git commit`. Record completion in the plan's progress ledger instead.
