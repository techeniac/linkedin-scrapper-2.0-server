# LinkedIn Reports — Architecture & How to Add a New Graph

**Purpose of this file:** hand this to a fresh session (or your future self) so it can pick up building graph #6+ without re-deriving the whole system. It covers: the two-repo split, the shared backend pattern all 5 existing graphs follow, the frontend template, and a full account of the 5th graph (Forgotten Active Leads) — including the parts of it that are still rough and worth fixing before piling more graphs on top.

## Repos and branches

Three separate git repos live under `D:/Techeniac Projects 2/linkedin/`:

- **`backend/`** — Node/TypeScript/Express/Prisma (Postgres) API. Base branch `dev`. All 5 graphs live in this one backend.
- **`frontend/`** — Next.js 13 (Pages Router) + MUI + Recharts dashboard. Base branch `main`. All 5 graphs render here.
- **`extension/`** — Chrome extension that scrapes LinkedIn and feeds the backend (messages/connections activity, HubSpot sync). Not touched by the reports work — only relevant as the source of the data graphs 1–2 read.

The 5th graph (Forgotten Active Leads) was built on branch **`feature/forgotten-leads-graph`** in both `backend` and `frontend` (forked from `dev`/`main` respectively). As of writing, that branch is **not merged** — it's sitting there with all the commits described below. Check `git log --oneline dev..feature/forgotten-leads-graph` (backend) / `git log --oneline main..feature/forgotten-leads-graph` (frontend) to see exactly what's unmerged before starting new work — decide whether graph #6 continues on this branch, a new branch off it, or waits for a merge first.

**No automated test suite exists in either repo** (backend: no test script in `package.json`, no `*.test.ts` files; frontend: same). Verification throughout this whole project was `tsc --noEmit` / `eslint`, manual code tracing, and live manual testing against the real app. Budget for that pattern continuing — don't assume you can write `npm test` and get signal.

## The backend pattern (all 5 graphs)

Layering is strict and consistent — copy it exactly for a new graph:

```
route (publicRoutes.ts) → controller (publicController.ts) → service (business logic) → repository (100% of Prisma/raw SQL)
```

- **`prisma/schema.prisma`** — one table per graph's data source, generally an **append-only event log** (e.g. `ConnectionRequestEvent`, `MessageEvent`) rather than a mutable current-state table, so historical reporting isn't corrupted by re-sends/updates. The one exception is graph 5 (see below) — HubSpot data isn't ours to log an event stream for, so it uses a **daily snapshot** table instead.
- **`src/repositories/<name>Repository.ts`** — owns every `prisma.$queryRaw`/`Prisma.sql` call. Standard method set: `getSeries(from, to, opts)`, `getSeriesByOwner(from, to, ownerIds, opts)`, `getTotals(...)`, plus a paginated `list`/`findQualifying*` for the table. Raw SQL buckets by `date_trunc($bucket, occurred_at)` with `COUNT(...) FILTER (WHERE ...)` per metric column. **Postgres gotcha hit once already** (see graph 5's Task 5 note below): if a `${param}` value is interpolated more than once inside one `prisma.$queryRaw` template, each occurrence becomes a *different* SQL parameter placeholder even though the JS value is identical — this breaks `DISTINCT ON (expr) ... ORDER BY expr` (Postgres requires them to be the literal same parsed expression). Always compute a repeated expression **once**, in a CTE, and reference the resulting column by name everywhere else.
- **`src/services/<name>Service.ts`** — business decisions only (which JS logic can't be SQL — e.g. quiet-hours math for the Late Messages graph), delegates fetching to the repository. When a metric needs both a chart series and a table, **fetch once, derive many views** via pure in-memory `buildSeries`/`buildTotals`/`buildSeriesByOwner` helpers — see `lateMessageService.ts` for the canonical example.
- **`src/controllers/publicController.ts`** — one giant `getSummary` handler serves ALL 5 graphs' chart data in one `Promise.all` fan-out (each entry only computed when actually requested — owner-breakdown queries short-circuit to `[]` on an empty id list). A new graph = one more entry in that `Promise.all` array + one more key in the final `successResponse(...)` payload object, plus (if it needs its own supporting table) one more `get<Graph>` controller function + one more route.
- **`src/routes/publicRoutes.ts`** — mounts everything under `/api/public/*`, behind `authenticate` (JWT) + an optional no-op `requirePublicApiKey` shared-secret layer. **Read-only, unauthenticated-in-spirit reporting API** — comment in the file: "read-only reporting data to the Chitragupt frontend." Do NOT add write endpoints here.
- **Shared filter dimensions every graph is expected to support**: owner scope (`userId`/`ownerIds`, validated against `getConnectedOwnerIds()` — HubSpot-connected users only, from `hubspotOwnersService.ts`), LinkedIn-account scope (`linkedinId`/`linkedinAccountIds`), date window with a per-granularity cap (`RANGE_CAP_MS` in `publicController.ts`), and per-owner/per-owner-account breakdown variants for the chart's stacked segments / hover popup.

### The 5 graphs today

| # | Report | Data source | Backend service | Table endpoint |
|---|---|---|---|---|
| 1 | Connections Activity | `ConnectionRequestEvent` (append-only) | `ConnectionEventService` | `GET /public/connections` |
| 2 | Messaging Activity | `MessageEvent` (append-only) | `MessageEventService` | `GET /public/messages` |
| 3 | Late Messages | derived from `MessageEvent` + quiet-hours JS math | `LateMessageService` | `GET /public/late-messages` |
| 4 | Missed Follow-Ups | derived from `MessageEvent` deadline logic | `MissedFollowUpService` | `GET /public/missed-followups` |
| 5 | **Forgotten Active Leads** | HubSpot Contact state, snapshotted daily | `ForgottenLeadService` | `GET /public/forgotten-leads` |

Graphs 1–4 all source from **our own Postgres event log**, populated by the extension. Graph 5 is fundamentally different — see below.

## HubSpot integration (background you need before touching graph 5 or building a graph on HubSpot data)

- OAuth per-`User` row (`hubspotAccessToken`/`hubspotRefreshToken`/`hubspotOwnerId`/`hubspotTokenExpiresAt` on `User`), refreshed via `HubSpotOAuthService.getValidAccessToken(userId)` — **always go through this**, never store a second token.
- `getConnectedOwners()` (`src/services/hubspotOwnersService.ts`) resolves which app `User`s are HubSpot-connected (own real owner names) — this is the master owner list every graph's owner filter validates against. It returns `{ id, name, hubspotOwnerId }` — note `hubspotOwnerId` was added specifically for graph 5 (to scope HubSpot Search API calls by owner); check it's still there if you refactor this file.
- **Backend never mirrors HubSpot Contact/Deal state in Postgres** — contacts are always fetched live from HubSpot's REST/Search API per request (see `hubspotContactService.ts`). Graph 5 is the first graph to build a chart off HubSpot state, and it had to invent a workaround for that (below) because of this.
- **No cron/scheduler exists in this backend, and the deploy target is Vercel's free tier**, which doesn't reliably support scheduled background jobs. Any "needs to run periodically" requirement has to be solved with a **lazy pattern**: do the expensive work on the first real request that needs it, cache the result, let it go stale and refresh on next demand — see graph 5's snapshot mechanism for the full pattern to copy.

## Graph 5 — Forgotten Active Leads — full writeup

**Business definition** (given by the product owner, verbatim): active HubSpot leads (Lead Status is NOT "Not Interested" and NOT "DND/Suspended") that have no task or activity ever recorded (Next Activity Date AND Last Activity Date both unknown). "Forgotten" = still worth chasing, but nobody has touched them.

**Why it's architecturally different from graphs 1–4:** it measures HubSpot Contact *state right now*, not something that *happened* and got logged locally. There's no event to log — so instead of an append-only table, it uses a **daily snapshot gauge**.

### The lazy-snapshot mechanism (the reusable pattern — read this if building another HubSpot-state graph)

- New table `ForgottenLeadSnapshot` (`prisma/schema.prisma`): `{ userId, snapshotDate (UTC midnight), count, createdAt }`, unique on `(userId, snapshotDate)`.
- `ForgottenLeadService.ensureTodaySnapshots(owners)` is called from `publicController.getSummary` on **every** request, but for each owner it first checks `ForgottenLeadRepository.hasSnapshotToday(ownerId, today)` — a single indexed existence check. Only when that's `false` does it call HubSpot (`countForgottenLeads`) and write the row. So: the first dashboard view of the UTC day pays one HubSpot round-trip per owner; every other view that day is a free DB read. This is the cron replacement — copy it verbatim for any new "count something in an external system periodically" need.
- **Gauge, not event count**: unlike graphs 1–4, a day's number is "how many were stuck as of the snapshot," never additive. `ForgottenLeadRepository.getSeries`/`getSeriesByOwner` take the **latest snapshot within each date bucket** (via a `DISTINCT ON` CTE) and only THEN sum across owners — never sum raw daily rows. `getTotal`/the KPI number is always the **latest known value**, not a windowed sum. If you build another gauge-style graph, copy this distinction carefully — summing a backlog size across days is meaningless.
- A per-owner in-memory failure cache (`failedToday` Map in `forgottenLeadService.ts`) caps a persistently-broken owner (bad token, wrong property config) to **one** HubSpot attempt per UTC day per process, so a misconfiguration doesn't retry-storm on every request.

### The HubSpot filter itself

All in `src/services/hubspotLeadSearchService.ts` — the **only** place this feature's filterGroups payload is built (both the snapshot count and the live table search call into it, so the two can never drift apart). 3 conditions, AND'd in one filterGroup:

```
propertyName: <lead status property>, operator: NOT_IN, values: <excluded statuses>
propertyName: <next activity property>, operator: NOT_HAS_PROPERTY
propertyName: <last activity property>, operator: NOT_HAS_PROPERTY
```

**These property names/values are portal-specific and were WRONG on first guess** — worth internalizing before assuming any HubSpot property name. `src/config/env.ts` exports them as env vars with code defaults that turned out partially wrong:

| Env var | Code default (guess) | Actual value verified live on this portal |
|---|---|---|
| `HUBSPOT_LEAD_STATUS_PROPERTY` | `hs_lead_status` | ✅ correct |
| `HUBSPOT_NEXT_ACTIVITY_PROPERTY` | `notes_next_activity_date` | ✅ correct |
| `HUBSPOT_LAST_ACTIVITY_PROPERTY` | `notes_last_activity_date` | ❌ wrong — real property is `notes_last_updated` |
| `HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES` | `NOT_INTERESTED,DND_SUSPENDED` | ❌ wrong — real option values are `Not Interested,DND/ Suspended` (exact casing/spacing, verified via live property options) |
| `HUBSPOT_PORTAL_ID` | `""` (no sane default) | `44305388` (this portal's hub ID) |

**The correct values live in the local `.env` file (gitignored, not in this repo's history)** — if you're starting a fresh session/environment, run `npx ts-node scripts/inspectForgottenLeadProperties.ts` (needs a real Postgres connection + at least one HubSpot-connected user) to re-derive them for whatever portal you're pointed at, then set all 5 vars in `.env`. A wrong guess here doesn't crash anything loudly — it manifests as **HubSpot 400 errors logged as `[ForgottenLeads] ... failed for owner ...`**, silently caught (fault-isolated per owner), and the graph just shows no data. Check the server log for that exact log line first if a HubSpot-backed graph "shows nothing."

`HUBSPOT_PORTAL_ID` is unrelated to the filter itself — it's needed to build a working `https://app.hubspot.com/contacts/<portalId>/contact/<id>` deep link (HubSpot's contact URL requires the portal ID; omitting it was a real bug caught in review — the link silently opened an access-denied page instead of the contact).

### Fault isolation (copy this if any graph touches an external API per-owner)

Every per-owner HubSpot call in this graph is wrapped in its own try/catch, inside the `Promise.all` map callback — never let one owner's failure reject the whole `Promise.all` and 500 the shared `getSummary` response that every other graph's data rides along in. `list()`'s per-owner failure returns `[]` for that owner and sets a `metadata.partial: true` flag (currently unused by the frontend, but available) rather than silently under-reporting with no signal at all.

### The "Connected On" filter and the frontend's secondary-dimension generalization

Originally the report just inherited a generic "LinkedIn Account" filter from the shared page template — but that filter is meaningless here (a HubSpot contact has no LinkedIn-account dimension), so it silently did nothing. Investigated live and found `contact_source` (an existing HubSpot property, one enum option per sales rep's LinkedIn profile — already used elsewhere in this codebase as "Connected On Source", see `hubspotContactService.ts`) was the real, usable dimension. Wired it in:

- **Backend**: `hubspotLeadSearchService.searchForgottenLeads` accepts `connectedOnSources?: string[]`, added as a 4th `IN`-operator filter in the SAME filterGroup (AND semantics) — **table-only**, the daily snapshot/chart stays owner-only (splitting the snapshot by source would need a schema change, not justified yet). `GET /public/filters` now also returns `connectedOnSources: [{value,label}]`, fetched live from HubSpot (`HubSpotContactService.getPropertyOptions()`), cached 30 min stale-while-revalidate (same shape as the owner/account caches already in `publicController.ts`).
- **Frontend**: the shared `ReportDashboardPage.jsx` component (used by all 5 reports) had its "LinkedIn Account" secondary dimension **hardcoded**. Generalized it via 3 new optional props — `secondaryOptions`, `secondaryLabelOverride`, `secondaryPairs` — so a report can plug in a totally different secondary dimension (Group By toggle + multi-select + optional co-occurrence narrowing) while the other 4 reports, which pass none of these props, keep byte-identical behavior. Forgotten Active Leads passes `secondaryOptions={connectedOnOptions}` (fetched from `/public/filters`) and `secondaryLabelOverride='Connected On'`, and deliberately omits `secondaryPairs` — meaning **no co-occurrence narrowing exists for this dimension** (both Sales Person and Connected On always show their full option lists, unlike LinkedIn Account which narrows to what actually co-occurs). Building real narrowing would need a new live HubSpot query with no existing cheap endpoint — flagged as a known gap, not fixed.
- **If you add a 6th graph with its own custom secondary dimension**: reuse this same mechanism (`secondaryOptions`/`secondaryLabelOverride`/`secondaryPairs` on `ReportDashboardPage`) rather than inventing a new one. Read the prop doc-comments at the top of `ReportDashboardPage.jsx`'s destructured props for the exact contract.

### The pagination-stability bug (a lesson, not just a fix)

The table (`ForgottenLeadService.list()`) originally re-fetched the **entire** matching-contact set from HubSpot from scratch on every single page click (up to 5 sequential 200-row calls per owner) — slow, and worse: any owner that transiently 429'd on one page's fetch but not another's changed `total`/`totalPages` between page loads, making the UI's pagination control visibly jump. Root cause was NOT a slicing bug — it was a different-length list being sliced on every request. Fixed with an in-memory cache (`listCache` in `forgottenLeadService.ts`) keyed by `(owner scope, connectedOnSources selection)`, with:
- a normal TTL (90s) for clean results, a much shorter TTL (15s) for `partial` (known-degraded) results — don't pin bad data as long as good data,
- an eviction sweep + hard size cap on every write (this endpoint is on the unauthenticated public API, so the cache key space isn't naturally bounded),
- one in-flight promise per key (mirrors the `coInFlight`/`laInFlight` pattern already used for the owner/account caches) so concurrent requests for the same cold key share one HubSpot fan-out instead of each running it independently.

**Lesson for future graphs**: any table/chart that live-queries an external, rate-limited API per request needs this same shape of cache from day one — don't wait for a user to report "pagination looks broken" to discover it.

## Frontend pattern (all 5 graphs)

- `src/pages/linkedin/<report>/index.js` — thin route wrapper: wraps the view in `LinkedinAuthGuard`, sets `Component.authGuard = false` to skip the unrelated Techeniac auth guard.
- `src/views/linkedin/<report>/index.js` — the actual report: a config object (title, chart series definition, which `/summary` fields to read, `fetchRows`/`mapRow` for the table, `columns`) fed into the one shared template component.
- `src/views/linkedin/components/ReportDashboardPage.jsx` — the shared page shell used by ALL 5 reports: filter toolbar (Group By toggle, primary/secondary multi-selects, optional `extraFilter`, date range), chart card with legend, searchable/sortable/paginated table. **Read this file's prop doc-comments in full before building a new report** — it owns all filter/sort/pagination state and is genuinely reusable, but it's also the single highest-blast-radius file in the frontend (5 live reports depend on it with zero test coverage).
- `src/views/linkedin/components/StackedOwnerBarChart.jsx` — the one chart component all 5 reports use (Recharts stacked bar, one series per status/metric, subdivided by owner via an opacity ladder). Forgotten Active Leads uses it with a single series (`count`) since it only measures one thing, unlike graphs 1–4's multi-status series.
- `src/services/linkedinService.js` — one `fetch<Report>` wrapper function per report/table, all following the same shape: destructure array params, `joinIds()` them into a comma-joined query value, unwrap the `{success,message,data}` envelope.
- Add the new route to `src/navigation/vertical/index.js`'s "LinkedIn Overview" nav group.

## Practical notes for the next session

- **No live Postgres/HubSpot may be reachable in a fresh sandbox** — this was true for most of graph 5's build. Verification substitutes: `npx tsc --noEmit` (backend), `npx eslint <files>` (frontend), manual SQL/control-flow tracing, and — critically — a `scripts/inspectForgottenLeadProperties.ts`-style one-off diagnostic script pattern for confirming live HubSpot property names/values when you do have DB access. Don't assume a guessed HubSpot property/enum value is right; verify it live before shipping a filter that depends on it.
- **Rate limits are real** — HubSpot's Search API has a per-second cap. Any new per-owner HubSpot fan-out (especially across 6+ connected owners, run in parallel) risks 429s. Cache aggressively (see the `listCache`/owner-cache patterns above) and fault-isolate per owner from day one.
- **When something "shows no data," check the server log first** for a `[<FeatureName>] ... failed for owner ...` line before assuming a code bug — the fault-isolation pattern used throughout this backend means failures are silent by design at the API-response level.
- **Worktrees**: this branch was originally built in `.worktrees/forgotten-leads-graph` under each repo, later removed in favor of checking the branch out directly in the main repo folders. If you see a `.worktrees/` directory reappear or references to it, that was a now-abandoned isolation mechanism — safe to ignore/clean up if empty.
