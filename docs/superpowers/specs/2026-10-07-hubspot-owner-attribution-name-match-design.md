# HubSpot Owner Attribution — Name-Match Resolution — Design

Date: 2026-10-07
Status: Approved via brainstorming (this revision), supersedes the earlier
draft of the same filename, which was written by a subagent outside the
brainstorming process and was never reviewed or approved.
Supersedes resolution strategy only in:
`docs/superpowers/specs/2026-09-01-hubspot-owner-attribution-design.md`

## Context

The 2026-09-01 design (branch `feature/hubspot-owner-attribution-spec`,
paused per `docs/superpowers/STATUS-hubspot-owner-attribution.md`) built
the full attribution pipeline — `conversation_owner_cache` table,
`message_events.resolvedOwnerId`/`attributionSource`, resolver service,
`COALESCE` grouping in all three report services, dedupe + backfill
scripts — on top of a resolution strategy that didn't work: LinkedIn's
message-sync data never carries a resolvable vanity handle for a
participant, only an opaque member URN, so matching against HubSpot's
`hs_linkedin_url` always misses. Verified against
`STATUS-hubspot-owner-attribution.md`: 17/17 test resolutions came back
`fallback`, 0 succeeded. The DB migrations for this pipeline exist in
`prisma/migrations/` but were manually dropped from the live Supabase DB
when the branch paused — code and live schema are currently out of sync.

The STATUS doc's own suggested next step was testing
`fetchLinkedInProfile(bare URN)` for a real `publicIdentifier` (exact
match, no collision risk, works retroactively). This was considered and
explicitly declined by the user in favor of proceeding directly with
name-matching, accepting the collision/no-match risk in exchange for not
spending time on an unverified spike.

This design replaces the resolution strategy with a name match —
comparing the participant name LinkedIn already gives at message-sync
time (`MessageActivity.participantName`) against HubSpot's
`firstname`/`lastname` contact properties — while reusing the existing
cache/schema/report-layer pipeline as-is. It adds a manual-override path
for cases a name match can't resolve, since name collisions and no-match
outcomes are expected to occur in real data, not just as a theoretical
edge case.

**Auth model correction from the 2026-09-01 draft:** this backend has no
JWT-based end-user login, no role/`isAdmin` column on `User`, and (prior
to this feature) no code anywhere reading `x-requester-email`/`x-scope`
headers — confirmed by grep across `src/`. The actual architecture: a
separate service (identified by the user as the one verified in Step 6
of the original plan — it already confirmed the shared `PUBLIC_API_KEY`
never leaks to the browser) owns real user identity and roles, and calls
this backend server-to-server using that shared API key. This design
introduces the `x-requester-email`/`x-scope` header pattern for the
first time, specifically for the new endpoints below, trusting those
headers fully once a request clears the existing `requirePublicApiKey`
gate — no second admin allowlist is kept in this service, since the API
key is already the real trust boundary and a local list would just be a
second thing to keep in sync with the calling service's own role
changes (including future super-admin tiers).

## Goals

1. Attribute message counts to the LinkedIn contact's real HubSpot owner
   via name match, reusing the existing cache/schema/report-layer wiring
   from the 2026-09-01 design unchanged.
2. Any conversation a name match can't cleanly resolve is excluded from
   Messages/Late Responses/Follow-up Tracking reports (not miscredited to
   the scraper) and surfaced on a dedicated needs-resolution list
   instead. Underlying `message_events` rows are never dropped or
   altered by this exclusion — only report queries filter them.
3. A manual-override write path lets a human pick the real owner for an
   unresolved conversation, from the live list of HubSpot-connected
   owners, with a full audit trail of who changed what and when. On
   resolution, every historical `message_events` row for that
   conversation is updated at once, so past messages retroactively
   appear under the correct owner — not just new messages going forward.
4. Resume the live-DB schema that was reverted when the branch paused,
   re-running the dedupe script as a safety check first.

## Non-goals

- Connections report / `connectionEventService.ts` — same shared-account
  attribution problem likely applies, stays deferred to a separate
  future pass (unchanged from the 2026-09-01 design).
- Fuzzy/approximate name matching — exact match only (case-insensitive,
  trimmed). No Levenshtein/soundex. A near-miss is zero matches, not a
  weak match.
- The `fetchLinkedInProfile(URN)` → real `publicIdentifier` spike —
  explicitly declined by the user; not revisited in this round.
- The needs-resolution list's UI / owner-picker page — backend API only
  this round (new read + write endpoints). Frontend page is separate
  future work.
- A background retry sweep for transient resolver failures — still
  explicitly deferred, same as the original design.
- A local admin allowlist or any role storage in this service — role
  decisions stay fully owned by the calling service; this backend only
  trusts the headers it's sent, gated by the existing shared API key.

## Architecture

### Branch strategy

New branch off `dev` (not `feature/hubspot-owner-attribution-spec`,
which stays as historical record of the blocked URN approach). Cherry-
pick what's reusable from it: the `conversation_owner_cache` schema, the
`MessageOwnerResolverService` skeleton (cache-check → resolve → persist
structure), and the report-layer `COALESCE(resolvedOwnerId, userId)`
wiring. Do not carry over the URN/`hs_linkedin_url` matching logic itself
— that's the piece being replaced.

### Schema

Building on the existing (currently code-only, DB-reverted) schema:

- `conversation_owner_cache.attributionSource` gains two new values:
  `'ambiguous'` and `'manual'` (alongside existing `'hubspot'` /
  `'fallback'`).
- `message_events.attributionSource` gets the same two new values, same
  column, no new column needed.
- New table `OwnerOverrideAudit` (insert-only, append-only — a
  `conversation_owner_cache` upsert alone would silently lose who
  performed a prior override):
  - `id` (PK)
  - `conversationKey`
  - `oldOwnerId` (nullable)
  - `newOwnerId`
  - `performedByEmail` (from the trusted `x-requester-email` header, not
    a local `User` FK — the human performing the override may not be a
    row in this service's own `User` table)
  - `performedAt`

Migration work: reapply the full migration set from the original branch
to the live DB (the `conversation_owner_cache` table,
`message_events`' `resolved_owner_id`/`attribution_source` columns, the
relaxed `@@unique([conversationKey, messageId])` constraint, the
effective-owner indexes) — these exist in `prisma/schema.prisma` and
`prisma/migrations/` already but were manually dropped from the live
Supabase DB when the branch paused. Add the `'ambiguous'`/`'manual'`
enum values and the new `OwnerOverrideAudit` table as new migrations on
top. Re-run `src/scripts/dedupeMessageEvents.ts` as a safety check
immediately before the unique-constraint migration is reapplied — it's
idempotent and should be a no-op if the original run's merge (1125
groups / 2069 rows, verified never reverted) is still intact; confirm
that before the constraint goes back on.

### Resolver (`MessageOwnerResolverService`)

Same cache-check → resolve → persist structure as today
(`backend/src/services/messageOwnerResolverService.ts`); only the inner
`resolveOwnerFromHubSpot` lookup changes:

1. Read `MessageActivity.participantName` for the conversation (same
   `userId_conversationKey` lookup already used for
   `participantProfileUrl` — just reading a different column off the
   same row).
2. Missing name (~2% of conversations) → `{ ownerId: null, source:
   'ambiguous' }` immediately, no HubSpot call attempted.
3. Split into first/last (same `split(" ")` convention already used in
   `hubspotContactService.ts`), call a new
   `findContactOwnerIdByName(firstName, lastName)` —
   `/crm/v3/objects/contacts/search` with `firstname`/`lastname` EQ
   filters (case-insensitive, trimmed), searched across all owners'
   contacts — same scope as the existing
   `findContactOwnerIdByProfileUrl` call today.
4. Outcomes:
   - 0 matches → `{ ownerId: null, source: 'ambiguous' }`.
   - 2+ matches → `{ ownerId: null, source: 'ambiguous' }` — no
     disambiguation signal exists in captured data (no company/email
     captured at message-sync time, only name + URN + the unusable
     URN-shaped "profile URL" field).
   - Exactly 1 match, no `hubspot_owner_id` on that contact → `{
     ownerId: null, source: 'ambiguous' }`.
   - Exactly 1 match, owner set, reverse-maps via `User.hubspotOwnerId`
     to a connected user → `{ ownerId: user.id, source: 'hubspot' }`.
   - API error / scraper's HubSpot connection invalid → unchanged from
     today: `{ ownerId: null, source: 'fallback', transient: true }`,
     NOT written to the cache (next message on that conversation
     retries instead of being stuck).

`'ambiguous'` results ARE cached (same as the existing permanent-
fallback case) — they're a stable fact about current HubSpot data,
re-checked only when a human resolves them via the override endpoint,
not retried automatically on every new message.

### Report layer

`messageEventService.ts`, `lateMessageService.ts`,
`missedFollowUpService.ts` and their repositories add one filter to
their existing `COALESCE(resolvedOwnerId, userId)` queries: exclude rows
where `attributionSource = 'ambiguous'`. Everything else is unchanged —
`'fallback'` (transient) rows still count under the scraper's `userId`
exactly as today; `'hubspot'` and `'manual'` rows count under the
resolved owner. Raw `message_events` rows are never deleted or hidden
outside of report queries — the exclusion is query-level only.

### New endpoints

New route file (not `publicRoutes.ts` — its "no write endpoints" comment
stays true for that file), behind `requirePublicApiKey` (existing
shared-secret gate) plus a new middleware reading `x-requester-email`
and `x-scope` headers sent by the calling service:

- `GET /api/owner-overrides` — lists conversations where
  `attributionSource = 'ambiguous'`. `x-scope` regular → only
  conversations where `x-requester-email` appears as scraper (`userId`)
  on at least one `message_events` row for that `conversationKey`
  (shared-LinkedIn-account reality: any scraper of that conversation can
  resolve it). `x-scope: all` → every ambiguous conversation regardless
  of scraper.
- `POST /api/owner-overrides/:conversationKey` — body `{ ownerId }`,
  must be one of `getConnectedOwners()`'s live set. Same scope rule as
  the GET. On success: upserts `conversation_owner_cache`
  (`resolvedOwnerId`, `attributionSource: 'manual'`), updates every
  `message_events` row for that `conversationKey` to match, and inserts
  an `OwnerOverrideAudit` row (`performedByEmail`: the trusted
  `x-requester-email`). From that point the conversation reports under
  the chosen owner like any other resolved row, including its full
  history.

### Auth

`requirePublicApiKey` (existing shared-secret shutter,
`backend/src/middlewares/publicApiKey.ts`) gates these endpoints exactly
as it gates today's public reads. On top of it, a new middleware reads
`x-requester-email` and `x-scope` from the request and trusts them
fully — no second local allowlist. Rationale: the API key is already
the real trust boundary (only the calling service holds it, and Step 6
of the prior investigation verified it never reaches the browser); a
local admin-email list would be a second source of truth to keep in
sync every time the calling service adds or removes an admin/super-
admin, for no additional real security. If the calling service is ever
not fully trusted for this specific write action, that's a reason to
revisit this decision — not a reason to add a redundant local check
today.

### Rate limiting

The write endpoint uses the existing `userAwareLimiter` pattern
(`backend/src/middlewares/rateLimiter.ts`), keyed off
`x-requester-email` — a new limiter instance with write-appropriate
limits, rather than relying on the global IP-based `apiLimiter` alone.

### Error handling

Unchanged from the original design for the transient case: API failure
or an unconnected scraper is logged, not cached, not user-facing, and
retried on the next message for that conversation. The new `'ambiguous'`
state is not an error — it's a stable, cached fact surfaced to a human
via the needs-resolution list, resolved only by an explicit override.

### Testing

- Unit: resolver outcomes for all six cases (missing name, 0 matches, 2+
  matches, 1 match/no owner, 1 match/resolved owner, transient failure).
- Integration: report queries correctly exclude `'ambiguous'` rows and
  include `'hubspot'`/`'manual'`/`'fallback'` rows under
  `COALESCE(resolvedOwnerId, userId)`; override endpoint updates
  `conversation_owner_cache`, `message_events`, and
  `OwnerOverrideAudit` together, and the conversation subsequently
  appears correctly attributed — including prior history — in report
  queries.
- Auth: regular scope can list/override only conversations where the
  requester email appears as a scraper; `all` scope can list/override
  any; a request missing or failing the API key is rejected before
  either header is read.
- Migration: dedupe script re-run against current live data is a no-op;
  unique-constraint migration applies cleanly afterward.

## Scope

In scope: Messages, Late Responses, Follow-up Tracking reports and their
backing services; `message_events`/`conversation_owner_cache` schema
reuse plus the `'ambiguous'`/`'manual'` enum additions; new
`OwnerOverrideAudit` table; resolver's name-match swap; report-layer
`'ambiguous'` exclusion; `GET`/`POST /api/owner-overrides` endpoints
with the new `x-requester-email`/`x-scope` header middleware; live-DB
migration reapply; dedupe re-run; new branch off `dev` with cherry-
picked reusable pieces from `feature/hubspot-owner-attribution-spec`.

Out of scope (deferred): Connections report; needs-resolution frontend
page; fuzzy name matching; the `fetchLinkedInProfile(URN)` spike; retry
sweep for transient failures; any local role/admin storage in this
service.
