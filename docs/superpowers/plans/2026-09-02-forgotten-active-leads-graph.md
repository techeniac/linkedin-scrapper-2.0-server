# Forgotten Active Leads Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 5th analytics graph — "Forgotten Active Leads" — showing, per HubSpot owner and over time, how many active (not Not-Interested / not DND-Suspended) HubSpot contacts have no task or activity ever recorded against them (both Next Activity Date and Last Activity Date unknown), plus a supporting table of the actual matching contacts.

**Architecture:** HubSpot Contact state (lead status + activity dates) is not mirrored locally anywhere in this codebase — it only ever gets fetched live from HubSpot's API per request. Because there is no local event log to bucket a historical chart from, and Vercel's free-tier cron is being avoided, this feature introduces a **lazy daily snapshot**: the first `/api/public/summary` request of each UTC day (per connected owner) triggers a live HubSpot Contact Search API count, which is written to a new `ForgottenLeadSnapshot` row. Every subsequent request that day reads the already-stored row — no scheduler, no queue, self-healing if the dashboard isn't opened for a few days (the gap in the chart just has no bars until the next visit backfills the current day). The chart reuses the existing `StackedOwnerBarChart` (single series, stacked by owner) exactly like the 4 existing graphs; the table reuses `ReportDashboardPage`'s table with a live (non-cached, non-snapshotted) HubSpot search for the current matching contacts.

**Tech Stack:** Backend: Node/TypeScript, Express, Prisma 5 (Postgres), axios (HubSpot REST). Frontend: Next.js 13 Pages Router, MUI v5, Recharts (via the existing `StackedOwnerBarChart`), React Query.

**Spec:** This plan's spec is the conversation history in this session (no separate spec doc was written — decisions are inlined below). Filter definition, verbatim from the user:

> Lead status → is none of → [Not Interested, DND/Suspended]
> Next activity date → is unknown
> Last activity date → is unknown
> (AND of the three)

## Global Constraints

- No new scheduler/cron/queue infrastructure — lazy on-request snapshotting only (Vercel free-tier constraint).
- HubSpot property internal names/option values used below (`hs_lead_status`, `notes_next_activity_date`, `notes_last_activity_date`) are **best-known defaults, not yet verified against the live portal** — Task 1 verifies them and they are wired through `config/env.ts` so a wrong guess is a one-line env-var fix, not a redeploy of logic.
- This codebase has **no automated test suite** (`package.json` only carries `@types/jest`, no test script, no `*.test.ts` files, no jest/vitest config). Do not introduce a new test framework as a side effect of this feature — each task instead ends with a concrete manual verification step (a script run, a `curl`, a browser check), matching how every existing service/repository in this codebase was actually verified.
- Follow the existing layering strictly: routes → controllers → services (business decisions) → repositories (100% of Prisma/raw SQL) — see `lateMessageService.ts` / `connectionEventRepository.ts` for the canonical shape this plan's new files copy.
- All new Prisma models/columns use the existing `@map("snake_case")` convention; all new raw SQL goes through `Prisma.sql`/`prisma.$queryRaw`, never string-interpolated.
- Response envelope stays `{ success, message, data }` via `successResponse`/`errorResponse` (`src/utils/apiResponse.ts`) — no new envelope shape.
- New HubSpot API calls reuse `HubSpotOAuthService.getValidAccessToken(userId)` for auth — never store a second token, never call HubSpot unauthenticated.
- KPI semantics: unlike the other 3 graphs, forgotten-lead counts are **not additive over a date range** (a backlog isn't "N events that happened this week", it's "N leads that are stuck right now"). `getTotals`/the KPI card always reports the **latest known snapshot**, and week/month chart buckets show the **last day's count within that bucket**, never a sum — this must be respected in every repository/service method below.

---

## File Structure

**Backend (`D:/Techeniac Projects 2/linkedin/backend`):**
- `scripts/inspectForgottenLeadProperties.ts` (new) — one-off diagnostic script, run manually once, to confirm the real internal property names/option values in the connected HubSpot portal.
- `prisma/schema.prisma` (modify) — add `ForgottenLeadSnapshot` model + `User.forgottenLeadSnapshots` relation.
- `src/config/env.ts` (modify) — add `HUBSPOT_LEAD_STATUS_PROPERTY`, `HUBSPOT_NEXT_ACTIVITY_PROPERTY`, `HUBSPOT_LAST_ACTIVITY_PROPERTY`, `HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES`.
- `.env.example` (modify) — document the same 4 vars.
- `src/services/hubspotLeadSearchService.ts` (new) — thin HubSpot Search API wrapper: `countForgottenLeads(token, ownerId)`, `searchForgottenLeads(token, ownerId, page, limit)`. Owns the actual filterGroups payload; nothing else touches HubSpot's Search API for this feature.
- `src/repositories/forgottenLeadRepository.ts` (new) — 100% of Prisma access for the new table: `upsertSnapshot`, `hasSnapshotToday`, `getSeries`, `getSeriesByOwner`, `getLatestTotals`.
- `src/services/forgottenLeadService.ts` (new) — business logic: `ensureTodaySnapshots(owners)` (the lazy-snapshot trigger), `getSeries`, `getSeriesByOwner`, `getTotals`, `list` (live HubSpot search, paginated, for the table).
- `src/controllers/publicController.ts` (modify) — call `ensureTodaySnapshots` + add 3 new fields to `getSummary`'s response; add new `getForgottenLeads` controller function.
- `src/routes/publicRoutes.ts` (modify) — add `GET /forgotten-leads`.

**Frontend (`D:/Techeniac Projects 2/linkedin/frontend`):**
- `src/services/linkedinService.js` (modify) — add `fetchForgottenLeads`.
- `src/views/linkedin/forgotten-leads/index.js` (new) — the report view (config object into `ReportDashboardPage`, mirroring `connections/index.js`).
- `src/pages/linkedin/forgotten-leads/index.js` (new) — route wrapper (mirrors `pages/linkedin/connections/index.js`).
- `src/navigation/vertical/index.js` (modify) — add the nav entry under "LinkedIn Overview".

---

## Task 1: Verify HubSpot property names against the live portal

**Files:**
- Create: `scripts/inspectForgottenLeadProperties.ts`

**Interfaces:**
- Consumes: `HubSpotOAuthService.getValidAccessToken(userId)` (existing, `src/services/hubspotOAuthService.ts:161`), `prisma` singleton (`src/config/prisma.ts`).
- Produces: nothing consumed by later tasks programmatically — this is a manual diagnostic run whose OUTPUT (the real property names/option values) feeds the env var defaults set in Task 3.

- [ ] **Step 1: Write the script**

```typescript
// scripts/inspectForgottenLeadProperties.ts
// One-off diagnostic: run manually (`npx ts-node scripts/inspectForgottenLeadProperties.ts`)
// against a real connected portal to confirm the internal property names/option
// values the Forgotten Active Leads graph filters on, before hardcoding any
// env-var default. Prints; does not write anything.
import axios from "axios";
import prisma from "../src/config/prisma";
import { HubSpotOAuthService } from "../src/services/hubspotOAuthService";

const HUBSPOT_BASE = "https://api.hubapi.com";

async function main() {
  const user = await prisma.user.findFirst({
    where: { hubspotAccessToken: { not: null }, hubspotOwnerId: { not: null } },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error("No HubSpot-connected user found — connect at least one account first.");
    process.exit(1);
  }
  console.log(`Using connected user: ${user.email} (${user.id})`);

  const token = await HubSpotOAuthService.getValidAccessToken(user.id);
  const headers = { Authorization: `Bearer ${token}` };

  console.log("\n--- hs_lead_status options ---");
  const leadStatus = await axios.get(
    `${HUBSPOT_BASE}/crm/v3/properties/contacts/hs_lead_status`,
    { headers },
  );
  for (const opt of leadStatus.data.options ?? []) {
    console.log(`  label="${opt.label}"  value="${opt.value}"`);
  }

  console.log("\n--- all contact properties whose name/label mentions 'activity' ---");
  const allProps = await axios.get(`${HUBSPOT_BASE}/crm/v3/properties/contacts`, { headers });
  for (const p of allProps.data.results ?? []) {
    const haystack = `${p.name} ${p.label}`.toLowerCase();
    if (haystack.includes("activity")) {
      console.log(`  name="${p.name}"  label="${p.label}"  type=${p.type}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err.response?.data ?? err.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run it and record the findings**

Run: `cd backend && npx ts-node scripts/inspectForgottenLeadProperties.ts`

Expected output: a list of `hs_lead_status` options (find the exact `value` for "Not Interested" and for "DND/Suspended" — labels can differ from internal values, e.g. `value="NOT_INTERESTED"` vs a custom string), and a list of activity-related properties (confirm whether `notes_next_activity_date` / `notes_last_activity_date` exist, or whether this portal instead exposes `hs_next_activity_date` / `hs_last_activity_date` — both naming generations exist across HubSpot portals depending on age/migration state).

Write down the 4 real values found — they feed directly into Task 3's env var defaults. If the script errors with "No HubSpot-connected user found", connect at least one account via the extension first (see `HubSpotOAuthService.getAuthUrl`).

- [ ] **Step 3: Commit**

```bash
git add scripts/inspectForgottenLeadProperties.ts
git commit -m "chore: add HubSpot property-name inspection script for forgotten-leads graph"
```

---

## Task 2: Add the ForgottenLeadSnapshot table

**Files:**
- Modify: `prisma/schema.prisma`
- Migration: generated by `prisma migrate dev`

**Interfaces:**
- Produces: Prisma model `ForgottenLeadSnapshot { id, userId, snapshotDate, count, createdAt }`, unique on `(userId, snapshotDate)`, consumed by `forgottenLeadRepository.ts` in Task 5.

- [ ] **Step 1: Add the model**

Add to `prisma/schema.prisma`, after the `MessageEvent` model (before `RefreshToken`):

```prisma
// Daily snapshot of "forgotten active leads" — active HubSpot contacts (not
// Not Interested / not DND-Suspended) with no task or activity EVER recorded
// (both Next Activity Date and Last Activity Date unknown). HubSpot Contact
// state is never mirrored locally elsewhere in this codebase (see
// hubspotContactService.ts — contacts are always fetched live), so unlike
// ConnectionRequestEvent/MessageEvent this is NOT an append-only fact log —
// it is a snapshot of a live HubSpot query result, taken at most once per
// (user, UTC calendar day). Written lazily: the first /api/public/summary
// request of the day for a given owner computes and stores it; every later
// request that day reads the stored row instead of re-querying HubSpot. This
// is what stands in for a cron job on a free-tier Vercel deployment that
// cannot schedule sub-daily (or, depending on plan, any) cron runs.
//
// NOT additive across days like MessageEvent/ConnectionRequestEvent — a
// backlog count is a gauge, not an event count. See ForgottenLeadService for
// how this is reflected in getSeries (last-value-per-bucket, never summed
// across days) and getTotals (latest row only).
model ForgottenLeadSnapshot {
  id           String   @id @default(uuid())
  userId       String   @map("user_id")
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  // Truncated to UTC midnight — the calendar day this snapshot represents,
  // not the instant it was computed (see createdAt for that).
  snapshotDate DateTime @map("snapshot_date")
  count        Int
  createdAt    DateTime @default(now()) @map("created_at")

  @@unique([userId, snapshotDate])
  @@index([snapshotDate])
  @@map("forgotten_lead_snapshots")
}
```

Add the relation to `User` (alongside the existing relation list at `prisma/schema.prisma:24-29`):

```prisma
  forgottenLeadSnapshots ForgottenLeadSnapshot[]
```

- [ ] **Step 2: Generate and run the migration**

Run: `cd backend && npx prisma migrate dev --name add_forgotten_lead_snapshot`
Expected: a new file under `prisma/migrations/<timestamp>_add_forgotten_lead_snapshot/migration.sql` creating the `forgotten_lead_snapshots` table, and `npx prisma generate` runs automatically, regenerating `@prisma/client` types to include `prisma.forgottenLeadSnapshot`.

- [ ] **Step 3: Verify**

Run: `npx prisma studio` (or `psql`) and confirm the `forgotten_lead_snapshots` table exists with columns `id, user_id, snapshot_date, count, created_at` and a unique index on `(user_id, snapshot_date)`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add ForgottenLeadSnapshot table for the forgotten-leads report"
```

---

## Task 3: Configurable property names / excluded statuses

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `HUBSPOT_LEAD_STATUS_PROPERTY: string`, `HUBSPOT_NEXT_ACTIVITY_PROPERTY: string`, `HUBSPOT_LAST_ACTIVITY_PROPERTY: string`, `HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES: string[]` — consumed by `hubspotLeadSearchService.ts` in Task 4.

- [ ] **Step 1: Add the env vars**

Add to `src/config/env.ts`, after the existing `HUBSPOT_SCOPES` line (`src/config/env.ts:130`):

```typescript
// Forgotten Active Leads report: which HubSpot contact properties carry lead
// status / next-activity-date / last-activity-date, and which lead-status
// values count as "not active" (excluded from the report). Configurable
// because these are per-portal property internal names, not HubSpot API
// constants — verified once via scripts/inspectForgottenLeadProperties.ts,
// then set here so a wrong guess or a future portal property rename is an
// env var change, not a redeploy of hubspotLeadSearchService.ts's logic.
export const HUBSPOT_LEAD_STATUS_PROPERTY =
  process.env.HUBSPOT_LEAD_STATUS_PROPERTY || "hs_lead_status";
export const HUBSPOT_NEXT_ACTIVITY_PROPERTY =
  process.env.HUBSPOT_NEXT_ACTIVITY_PROPERTY || "notes_next_activity_date";
export const HUBSPOT_LAST_ACTIVITY_PROPERTY =
  process.env.HUBSPOT_LAST_ACTIVITY_PROPERTY || "notes_last_activity_date";
export const HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES = (
  process.env.HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES || "NOT_INTERESTED,DND_SUSPENDED"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
```

Update the defaults above with whatever Task 1's script actually printed, if different from the guesses shown here.

- [ ] **Step 2: Document in `.env.example`**

Add near the existing `HUBSPOT_*` block in `.env.example`:

```
# Forgotten Active Leads report — see config/env.ts for the full explanation.
# Run scripts/inspectForgottenLeadProperties.ts against your portal to confirm these.
HUBSPOT_LEAD_STATUS_PROPERTY=hs_lead_status
HUBSPOT_NEXT_ACTIVITY_PROPERTY=notes_next_activity_date
HUBSPOT_LAST_ACTIVITY_PROPERTY=notes_last_activity_date
HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES=NOT_INTERESTED,DND_SUSPENDED
```

- [ ] **Step 3: Verify**

Run: `cd backend && npx ts-node -e "import('./src/config/env').then(e => console.log(e.HUBSPOT_LEAD_STATUS_PROPERTY, e.HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES))"`
Expected: prints `hs_lead_status [ 'NOT_INTERESTED', 'DND_SUSPENDED' ]` (or your corrected values).

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat: add configurable HubSpot property names for forgotten-leads report"
```

---

## Task 4: HubSpot Search API wrapper

**Files:**
- Create: `src/services/hubspotLeadSearchService.ts`

**Interfaces:**
- Consumes: `HUBSPOT_LEAD_STATUS_PROPERTY`, `HUBSPOT_NEXT_ACTIVITY_PROPERTY`, `HUBSPOT_LAST_ACTIVITY_PROPERTY`, `HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES` (Task 3).
- Produces: `countForgottenLeads(token: string, hubspotOwnerId: string): Promise<number>`, `searchForgottenLeads(token: string, hubspotOwnerId: string, page: number, limit: number): Promise<{ contacts: Array<{ id: string; name: string; email?: string; company?: string; leadStatus?: string; profileUrl: string }>; total: number }>` — consumed by `forgottenLeadService.ts` in Task 6.

- [ ] **Step 1: Write the service**

```typescript
// src/services/hubspotLeadSearchService.ts
//
// HubSpot Search API for the Forgotten Active Leads report: active contacts
// (lead status not in the excluded set) with NEITHER a next activity date NOR
// a last activity date ever recorded — i.e. nobody has created a task or
// logged any activity against them. See config/env.ts for why the property
// names/excluded values are env-driven rather than hardcoded.
//
// This is the ONLY place that builds this feature's HubSpot filterGroups
// payload — forgottenLeadService.ts calls in here for both the daily
// snapshot count and the live supporting-table search, so the filter
// definition can never drift between the two call sites.
import axios from "axios";
import logger from "../utils/logger";
import {
  HUBSPOT_LEAD_STATUS_PROPERTY,
  HUBSPOT_NEXT_ACTIVITY_PROPERTY,
  HUBSPOT_LAST_ACTIVITY_PROPERTY,
  HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES,
} from "../config/env";

const HUBSPOT_BASE = "https://api.hubapi.com";

function buildFilterGroups() {
  return [
    {
      filters: [
        {
          propertyName: HUBSPOT_LEAD_STATUS_PROPERTY,
          operator: "NOT_IN",
          values: HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES,
        },
        { propertyName: HUBSPOT_NEXT_ACTIVITY_PROPERTY, operator: "NOT_HAS_PROPERTY" },
        { propertyName: HUBSPOT_LAST_ACTIVITY_PROPERTY, operator: "NOT_HAS_PROPERTY" },
      ],
    },
  ];
}

/** Total count of forgotten active leads for one HubSpot owner. limit=1 — only `total` is read. */
export async function countForgottenLeads(token: string, hubspotOwnerId: string): Promise<number> {
  try {
    const response = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [
          {
            filters: [
              { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
              ...buildFilterGroups()[0].filters,
            ],
          },
        ],
        limit: 1,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return response.data?.total ?? 0;
  } catch (err: any) {
    logger.error(
      `[ForgottenLeads] countForgottenLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}

export interface ForgottenLeadContact {
  id: string;
  name: string;
  email?: string;
  company?: string;
  leadStatus?: string;
  profileUrl: string;
}

/** Paginated list of the actual matching contacts, for the report's supporting table. */
export async function searchForgottenLeads(
  token: string,
  hubspotOwnerId: string,
  page: number,
  limit: number,
): Promise<{ contacts: ForgottenLeadContact[]; total: number }> {
  const after = String(Math.max(0, (page - 1) * limit));
  try {
    const response = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [
          {
            filters: [
              { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
              ...buildFilterGroups()[0].filters,
            ],
          },
        ],
        properties: ["firstname", "lastname", "email", "company", HUBSPOT_LEAD_STATUS_PROPERTY],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        limit,
        after,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const results: any[] = response.data?.results ?? [];
    const contacts: ForgottenLeadContact[] = results.map((r) => ({
      id: r.id,
      name: [r.properties?.firstname, r.properties?.lastname].filter(Boolean).join(" ") || r.id,
      email: r.properties?.email || undefined,
      company: r.properties?.company || undefined,
      leadStatus: r.properties?.[HUBSPOT_LEAD_STATUS_PROPERTY] || undefined,
      profileUrl: `https://app.hubspot.com/contacts/${r.id}`,
    }));
    return { contacts, total: response.data?.total ?? 0 };
  } catch (err: any) {
    logger.error(
      `[ForgottenLeads] searchForgottenLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}
```

Note: `profileUrl` above uses a generic `app.hubspot.com/contacts/<id>` link (no portal ID hardcoded, so it resolves via the viewer's own logged-in HubSpot session) — matches the spirit of `conversationUrlFromKey` in `publicController.ts`, a deep link that only resolves for someone with access, which is correct here since only HubSpot users should follow it.

- [ ] **Step 2: Verify**

Write a throwaway script or reuse Task 1's script pattern: call `countForgottenLeads(token, someConnectedOwner.hubspotOwnerId)` for a real connected owner and confirm it returns a plausible integer (compare against manually applying the same 3 filters in HubSpot's own UI list view, per the user's original filter description, to confirm the count matches).

- [ ] **Step 3: Commit**

```bash
git add src/services/hubspotLeadSearchService.ts
git commit -m "feat: add HubSpot search wrapper for forgotten active leads"
```

---

## Task 5: Repository — snapshot storage and series queries

**Files:**
- Create: `src/repositories/forgottenLeadRepository.ts`

**Interfaces:**
- Consumes: `prisma` singleton, `Prisma.sql`/`Prisma.empty` (matches `connectionEventRepository.ts` conventions).
- Produces: `upsertSnapshot(userId, snapshotDate, count)`, `hasSnapshotToday(userId, today): Promise<boolean>`, `getSeries(from, to, opts): Promise<Array<{date, count}>>`, `getSeriesByOwner(from, to, ownerIds, opts): Promise<Array<{date, userId, count}>>`, `getLatestTotal(ownerIds): Promise<number>` — consumed by `forgottenLeadService.ts` in Task 6.

- [ ] **Step 1: Write the repository**

```typescript
// src/repositories/forgottenLeadRepository.ts
//
// Data-access layer for forgotten_lead_snapshots. Owns every Prisma/raw-SQL
// touch point; ForgottenLeadService owns the business decisions (when to
// (re)compute a snapshot, how to shape the report series).
//
// UNLIKE connectionEventRepository/messageEventRepository, this is a GAUGE,
// not an event count: a bucket's number is "how many were stuck as of the
// last snapshot IN that bucket", never a SUM across days in the bucket (see
// the ForgottenLeadSnapshot model comment in schema.prisma for why summing a
// backlog count across days would be meaningless).
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";

type FilterOpts = { userId?: string; restrictUserIds?: string[] };

const bucketOf = (granularity?: "day" | "week" | "month") =>
  granularity === "week" ? "week" : granularity === "month" ? "month" : "day";

const ownerFilterSql = (opts: FilterOpts) =>
  opts.userId
    ? Prisma.sql`AND user_id = ${opts.userId}`
    : opts.restrictUserIds
      ? Prisma.sql`AND user_id = ANY(${opts.restrictUserIds})`
      : Prisma.empty;

export class ForgottenLeadRepository {
  static async upsertSnapshot(userId: string, snapshotDate: Date, count: number): Promise<void> {
    await prisma.forgottenLeadSnapshot.upsert({
      where: { userId_snapshotDate: { userId, snapshotDate } },
      update: { count },
      create: { userId, snapshotDate, count },
    });
  }

  static async hasSnapshotToday(userId: string, todayUtcMidnight: Date): Promise<boolean> {
    const row = await prisma.forgottenLeadSnapshot.findUnique({
      where: { userId_snapshotDate: { userId, snapshotDate: todayUtcMidnight } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Per-bucket count, summed across whichever owners are in scope. For
   * day granularity this is exactly "sum of every in-scope owner's count that
   * day". For week/month, each owner contributes only their LAST snapshot
   * within the bucket (not a sum of their days) before the cross-owner sum —
   * see the class doc comment.
   */
  static getSeries(
    from: Date,
    to: Date,
    opts: FilterOpts & { granularity?: "day" | "week" | "month" } = {},
  ): Promise<Array<{ date: string; count: number }>> {
    const bucket = bucketOf(opts.granularity);
    const ownerFilter = ownerFilterSql(opts);
    return prisma.$queryRaw`
      WITH latest_per_bucket AS (
        SELECT DISTINCT ON (user_id, date_trunc(${bucket}, snapshot_date))
          user_id, date_trunc(${bucket}, snapshot_date) AS bucket, count
        FROM forgotten_lead_snapshots
        WHERE snapshot_date >= ${from} AND snapshot_date <= ${to}
          ${ownerFilter}
        ORDER BY user_id, date_trunc(${bucket}, snapshot_date), snapshot_date DESC
      )
      SELECT to_char(bucket, 'YYYY-MM-DD') AS date, SUM(count)::int AS count
      FROM latest_per_bucket
      GROUP BY bucket
      ORDER BY bucket
    `;
  }

  /** Same as getSeries, additionally split by owner — one entry per (date, userId). */
  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: { granularity?: "day" | "week" | "month" } = {},
  ): Promise<Array<{ date: string; userId: string; count: number }>> {
    if (!ownerIds.length) return Promise.resolve([]);
    const bucket = bucketOf(opts.granularity);
    return prisma.$queryRaw`
      SELECT DISTINCT ON (user_id, date_trunc(${bucket}, snapshot_date))
        to_char(date_trunc(${bucket}, snapshot_date), 'YYYY-MM-DD') AS date,
        user_id AS "userId",
        count
      FROM forgotten_lead_snapshots
      WHERE snapshot_date >= ${from} AND snapshot_date <= ${to}
        AND user_id = ANY(${ownerIds})
      ORDER BY user_id, date_trunc(${bucket}, snapshot_date), snapshot_date DESC
    `;
  }

  /** Sum of each in-scope owner's MOST RECENT snapshot ever recorded — the "right now" KPI. */
  static async getLatestTotal(ownerIds: string[]): Promise<number> {
    if (!ownerIds.length) return 0;
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT DISTINCT ON (user_id) count
      FROM forgotten_lead_snapshots
      WHERE user_id = ANY(${ownerIds})
      ORDER BY user_id, snapshot_date DESC
    `;
    return rows.reduce((sum, r) => sum + r.count, 0);
  }
}
```

- [ ] **Step 2: Verify**

Run: `cd backend && npx ts-node -e "
import prisma from './src/config/prisma';
import { ForgottenLeadRepository } from './src/repositories/forgottenLeadRepository';
(async () => {
  const u = await prisma.user.findFirst({ where: { hubspotOwnerId: { not: null } } });
  if (!u) return console.log('no connected user');
  await ForgottenLeadRepository.upsertSnapshot(u.id, new Date(new Date().toISOString().slice(0,10)), 7);
  console.log(await ForgottenLeadRepository.getSeries(new Date(Date.now()-7*86400000), new Date()));
  console.log(await ForgottenLeadRepository.getLatestTotal([u.id]));
  await prisma.\$disconnect();
})();
"`
Expected: the series array includes today's date with `count: 7`, and `getLatestTotal` returns `7`.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/forgottenLeadRepository.ts
git commit -m "feat: add ForgottenLeadRepository for the forgotten-leads report"
```

---

## Task 6: Service — lazy snapshot + report methods

**Files:**
- Create: `src/services/forgottenLeadService.ts`

**Interfaces:**
- Consumes: `ForgottenLeadRepository` (Task 5), `countForgottenLeads`/`searchForgottenLeads` (Task 4), `HubSpotOAuthService.getValidAccessToken` (existing), `ConnectedOwner` type (existing, `hubspotOwnersService.ts:13`).
- Produces: `ensureTodaySnapshots(owners: Array<{id: string; hubspotOwnerId: string}>): Promise<void>`, `getSeries(from, to, opts): Promise<...>`, `getSeriesByOwner(from, to, ownerIds, opts): Promise<...>`, `getTotal(ownerIds): Promise<number>`, `list(params): Promise<{data, metadata}>` — consumed by `publicController.ts` in Task 7.

- [ ] **Step 1: Write the service**

```typescript
// src/services/forgottenLeadService.ts
//
// Forgotten Active Leads report: active HubSpot contacts (lead status not
// Not-Interested/DND-Suspended) with no task or activity ever recorded
// against them. See hubspotLeadSearchService.ts for the exact HubSpot filter,
// and the ForgottenLeadSnapshot model comment in schema.prisma for why this
// is snapshot-based rather than an append-only event log like the other 3
// reports.
//
// LAZY SNAPSHOT: ensureTodaySnapshots is called from publicController.getSummary
// on every request, but only ever calls HubSpot for an owner whose row for
// TODAY (UTC) doesn't exist yet — every other call is a single indexed
// existence check. This is the stand-in for a cron job: the first dashboard
// view of the day (across ALL viewers) pays the HubSpot round-trip; every
// later view that day is pure DB reads.
import { ForgottenLeadRepository } from "../repositories/forgottenLeadRepository";
import { countForgottenLeads, searchForgottenLeads } from "./hubspotLeadSearchService";
import { HubSpotOAuthService } from "./hubspotOAuthService";
import logger from "../utils/logger";

export interface OwnerRef {
  id: string; // our User.id
  hubspotOwnerId: string;
}

function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export class ForgottenLeadService {
  /**
   * For every given owner, compute + store today's snapshot IF one doesn't
   * already exist. Failures are logged and skipped per-owner (one owner's
   * expired/revoked HubSpot token must never block the whole dashboard from
   * loading — the chart just shows a gap for that owner today).
   */
  static async ensureTodaySnapshots(owners: OwnerRef[]): Promise<void> {
    const today = todayUtcMidnight();
    await Promise.all(
      owners.map(async (owner) => {
        try {
          const exists = await ForgottenLeadRepository.hasSnapshotToday(owner.id, today);
          if (exists) return;
          const token = await HubSpotOAuthService.getValidAccessToken(owner.id);
          const count = await countForgottenLeads(token, owner.hubspotOwnerId);
          await ForgottenLeadRepository.upsertSnapshot(owner.id, today, count);
        } catch (err: any) {
          logger.warn(
            `[ForgottenLeads] snapshot failed for owner ${owner.id}: ${err?.message ?? err}`,
          );
        }
      }),
    );
  }

  static getSeries(
    from: Date,
    to: Date,
    opts: { userId?: string; restrictUserIds?: string[]; granularity?: "day" | "week" | "month" } = {},
  ) {
    return ForgottenLeadRepository.getSeries(from, to, opts);
  }

  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: { granularity?: "day" | "week" | "month" } = {},
  ) {
    return ForgottenLeadRepository.getSeriesByOwner(from, to, ownerIds, opts);
  }

  /** Latest known backlog size, summed across the given owners — a gauge, not a windowed sum. */
  static getTotal(ownerIds: string[]): Promise<number> {
    return ForgottenLeadRepository.getLatestTotal(ownerIds);
  }

  /**
   * Paginated supporting-table rows: the ACTUAL matching contacts, fetched
   * live from HubSpot (never from the snapshot table, which only stores a
   * count) — scoped to exactly one owner at a time, since HubSpot's Search
   * API filters by a single hubspot_owner_id per call. When multiple owners
   * are in scope, pages are fetched per-owner and concatenated/re-paginated
   * in memory (bounded — see the 1000-contact cap, matching the existing
   * getAllContactsForOwner pattern in hubspotContactService.ts).
   */
  static async list(params: {
    page: number;
    limit: number;
    owners: OwnerRef[]; // already scoped to the requested/allowed owners
  }): Promise<{
    data: Array<{ id: string; userId: string; name: string; email?: string; company?: string; leadStatus?: string; profileUrl: string }>;
    metadata: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));

    // Fetch each owner's full matching set (capped at 1000/owner, same bound
    // hubspotContactService.getAllContactsForOwner uses) so multi-owner scope
    // can be paginated as one combined, stably-ordered list.
    const perOwner = await Promise.all(
      params.owners.map(async (owner) => {
        try {
          const token = await HubSpotOAuthService.getValidAccessToken(owner.id);
          const all: Array<ReturnType<typeof mapContact>> = [];
          let page_ = 1;
          const pageSize = 200;
          while (all.length < 1000) {
            const { contacts, total } = await searchForgottenLeads(token, owner.hubspotOwnerId, page_, pageSize);
            all.push(...contacts.map((c) => mapContact(c, owner.id)));
            if (all.length >= total || contacts.length === 0) break;
            page_++;
          }
          return all;
        } catch (err: any) {
          logger.warn(`[ForgottenLeads] list failed for owner ${owner.id}: ${err?.message ?? err}`);
          return [];
        }
      }),
    );

    const combined = perOwner.flat();
    const total = combined.length;
    const start = (page - 1) * limit;
    const data = combined.slice(start, start + limit);

    return {
      data,
      metadata: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }
}

function mapContact(
  c: { id: string; name: string; email?: string; company?: string; leadStatus?: string; profileUrl: string },
  userId: string,
) {
  return { ...c, userId };
}
```

- [ ] **Step 2: Verify**

Run a throwaway script exercising `ForgottenLeadService.ensureTodaySnapshots([{ id: user.id, hubspotOwnerId: user.hubspotOwnerId }])` for a real connected user, then confirm `ForgottenLeadRepository.hasSnapshotToday` returns `true` and `getTotal([user.id])` matches the count from Task 4's manual verification.

- [ ] **Step 3: Commit**

```bash
git add src/services/forgottenLeadService.ts
git commit -m "feat: add ForgottenLeadService with lazy daily snapshotting"
```

---

## Task 7: Wire into the public API

**Files:**
- Modify: `src/controllers/publicController.ts`
- Modify: `src/routes/publicRoutes.ts`

**Interfaces:**
- Consumes: `ForgottenLeadService` (Task 6), `getConnectedOwners()` (existing, `hubspotOwnersService.ts:82` — note this already returns `{id, name}`, so it must be extended to also expose `hubspotOwnerId` for this feature; see step 1a).
- Produces: 3 new fields on `GET /api/public/summary`'s response (`forgottenLeadsSeries`, `forgottenLeadsSeriesByOwner`, `forgottenLeadsTotal`), and a new `GET /api/public/forgotten-leads` endpoint.

- [ ] **Step 1a: Expose `hubspotOwnerId` on `ConnectedOwner`**

In `src/services/hubspotOwnersService.ts`, extend the interface and the mapping (this is the one pre-existing file this task touches outside its own new files, because today's `ConnectedOwner` intentionally only carries `{id, name}` and this feature is the first consumer that needs the raw HubSpot owner id too):

```typescript
export interface ConnectedOwner {
  id: string; // our User.id
  name: string | null; // HubSpot display name (falls back to DB name on failure)
  hubspotOwnerId: string; // raw HubSpot owner id — needed to scope HubSpot Search API calls
}
```

And in `loadConnectedOwners` (`hubspotOwnersService.ts:26-60`), change the `select` to also pull `hubspotOwnerId`, and the returned object to include it:

```typescript
  const users = await prisma.user.findMany({
    where: {
      hubspotAccessToken: { not: null },
      hubspotRefreshToken: { not: null },
      hubspotOwnerId: { not: null },
    },
    select: { id: true, name: true, hubspotOwnerId: true },
  });

  return Promise.all(
    users.map(async (u): Promise<ConnectedOwner> => {
      let name: string | null = u.name;
      if (u.hubspotOwnerId) {
        try {
          const token = await HubSpotOAuthService.getValidAccessToken(u.id);
          const hsName = await getOwnerById(u.hubspotOwnerId, HUBSPOT_BASE, {
            Authorization: `Bearer ${token}`,
          });
          if (hsName) name = hsName;
        } catch (err: any) {
          logger.warn(
            `[public] HubSpot owner name lookup failed for ${u.id}: ${err?.message}`,
          );
        }
      }
      return { id: u.id, name, hubspotOwnerId: u.hubspotOwnerId! };
    }),
  );
```

(The `where` clause already guarantees `hubspotOwnerId` is non-null for every returned row — the `!` is safe.)

- [ ] **Step 1b: Extend `getSummary`**

In `src/controllers/publicController.ts`, add the import:

```typescript
import { ForgottenLeadService } from "../services/forgottenLeadService";
```

Inside `getSummary` (`publicController.ts:190-406`), right after `const owners = await getConnectedOwners();` (line 207), add the lazy-snapshot trigger:

```typescript
    // Lazy daily snapshot — see ForgottenLeadService for why this replaces a
    // cron job. Cheap on every call after the first per owner per UTC day
    // (a single indexed existence check); only calls HubSpot when a day's
    // snapshot is genuinely missing.
    await ForgottenLeadService.ensureTodaySnapshots(
      owners.map((o) => ({ id: o.id, hubspotOwnerId: o.hubspotOwnerId })),
    );
```

Then extend the `Promise.all` array (`publicController.ts:247-339`) with 2 more entries — `forgottenLeadsSeries` and `forgottenLeadsSeriesByOwner`:

```typescript
      ForgottenLeadService.getSeries(from, to, {
        userId,
        restrictUserIds: ownerScope,
        granularity,
      }),
      ForgottenLeadService.getSeriesByOwner(from, to, breakdownOwnerIds, { granularity }),
```

(destructure the results into 2 more names in the array-destructure at the top of that `const [...] = await Promise.all([...])` block, matching every other entry's position), and add the total alongside the other `Promise.all`-independent totals (near `pendingNow` at line 376):

```typescript
    const forgottenLeadsTotal = await ForgottenLeadService.getTotal(ownerScope);
```

Finally add all 3 to the `successResponse` payload object (`publicController.ts:378-402`):

```typescript
        forgottenLeadsSeries,
        forgottenLeadsSeriesByOwner,
        forgottenLeadsTotal,
```

- [ ] **Step 2: Add the `getForgottenLeads` list controller**

Add to `src/controllers/publicController.ts`, after `getMissedFollowUps`:

```typescript
// GET /api/public/forgotten-leads — supporting table for the Forgotten Active
// Leads report: the actual matching HubSpot contacts, fetched LIVE (not from
// the snapshot table, which only stores a count) — see ForgottenLeadService.list.
// No date-range filter (a HubSpot contact's current state has no "occurred at"
// to window by, unlike the other 3 tables) — just owner scope + pagination.
export const getForgottenLeads = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const owners = await getConnectedOwners();
    const ownerIds = owners.map((o) => o.id);
    const { userId, userIds } = resolveOwnerScope(req, ownerIds);
    const scopedIds = userId ? [userId] : userIds ?? ownerIds;
    const scopedOwners = owners.filter((o) => scopedIds.includes(o.id));

    const result = await ForgottenLeadService.list({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      owners: scopedOwners.map((o) => ({ id: o.id, hubspotOwnerId: o.hubspotOwnerId })),
    });

    const nameMap = await getConnectedOwnerNameMap();
    const data = result.data.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email ?? null,
      company: r.company ?? null,
      leadStatus: r.leadStatus ?? null,
      profileUrl: r.profileUrl,
      user: { name: nameMap.get(r.userId) ?? null },
    }));

    successResponse(res, { data, metadata: result.metadata }, "Forgotten leads retrieved");
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 3: Add the route**

In `src/routes/publicRoutes.ts`, add the import and the route:

```typescript
import {
  getSummary,
  getFilters,
  getConnections,
  getMessages,
  getLateMessages,
  getMissedFollowUps,
  getForgottenLeads,
} from "../controllers/publicController";
```

```typescript
router.get("/forgotten-leads", getForgottenLeads);
```

- [ ] **Step 4: Verify**

Run: `cd backend && npm run dev` (or the project's existing dev-start script), then:
```bash
curl -s http://localhost:3000/api/public/summary | jq '.data | {forgottenLeadsSeries, forgottenLeadsSeriesByOwner, forgottenLeadsTotal}'
curl -s http://localhost:3000/api/public/forgotten-leads | jq '.data'
```
Expected: `forgottenLeadsSeries` includes today's bucket with a plausible count (matching Task 4/6's manual counts), `forgottenLeadsTotal` is a single number, and `/forgotten-leads` returns a `data` array of contact rows with `name`/`leadStatus`/`profileUrl`/`user.name` populated. Confirm a SECOND call within the same UTC day does NOT re-trigger a HubSpot search (check logs — no `[HubSpot]`/`ForgottenLeads` snapshot log line the second time, only the first).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/publicController.ts src/routes/publicRoutes.ts src/services/hubspotOwnersService.ts
git commit -m "feat: expose forgotten-leads series/table on the public reporting API"
```

---

## Task 8: Frontend API client

**Files:**
- Modify: `src/services/linkedinService.js`

**Interfaces:**
- Consumes: `api` (existing `linkedinAPICall.js` axios instance), `unwrap`, `joinIds` (existing helpers in this same file).
- Produces: `fetchForgottenLeads({ userIds, page, limit, sortBy, sortOrder }) => Promise<{data, metadata}>` — consumed by `views/linkedin/forgotten-leads/index.js` in Task 9.

- [ ] **Step 1: Add the fetch function**

Add to `D:/Techeniac Projects 2/linkedin/frontend/src/services/linkedinService.js`, after `fetchMissedFollowUps`:

```javascript
// Paginated forgotten-active-leads rows (Forgotten Leads report). No date-range
// filter — a HubSpot contact's current state has no "occurred at" to window
// by, unlike the other 4 reports' tables. Returns { data, metadata }.
export const fetchForgottenLeads = async ({ userIds, ...params } = {}) => {
  const res = await api.get('/public/forgotten-leads', {
    params: { ...params, userIds: joinIds(userIds) }
  })

  return unwrap(res)
}
```

- [ ] **Step 2: Verify**

Run the frontend dev server (`npm run dev` in `frontend/`), open the browser console on any existing `/linkedin/*` page, and run:
```javascript
import('/src/services/linkedinService').then(m => m.fetchForgottenLeads({ page: 1, limit: 5 }).then(console.log))
```
(or add a temporary `console.log` call inside any existing view during dev) — expected: the same shape returned by the backend's `curl` check in Task 7 Step 4.

- [ ] **Step 3: Commit**

```bash
git add src/services/linkedinService.js
git commit -m "feat: add fetchForgottenLeads API client"
```

---

## Task 9: Frontend report page + navigation

**Files:**
- Create: `src/views/linkedin/forgotten-leads/index.js`
- Create: `src/pages/linkedin/forgotten-leads/index.js`
- Modify: `src/navigation/vertical/index.js`

**Interfaces:**
- Consumes: `ReportDashboardPage` (existing, `src/views/linkedin/components/ReportDashboardPage.jsx`), `fetchForgottenLeads` (Task 8), `LinkedinAuthGuard` (existing).
- Produces: the `/linkedin/forgotten-leads` route.

- [ ] **Step 1: Write the view**

Create `D:/Techeniac Projects 2/linkedin/frontend/src/views/linkedin/forgotten-leads/index.js`:

```javascript
// Forgotten Active Leads — Report 5. Shared ReportDashboardPage template;
// data comes from the LinkedIn Scrapper backend's /api/public/summary +
// /api/public/forgotten-leads (see src/services/linkedinService.js).
//
// Single-series chart (unlike the other 4 reports' multi-status series) —
// this report only ever measures ONE thing (how many active leads have no
// task/activity), stacked by owner via the same StackedOwnerBarChart used
// everywhere else. No date-range table filter: a HubSpot contact's CURRENT
// state has no per-row date to filter/sort by, so this table is not
// searchable and has no sortable columns (see fetchForgottenLeads).
import Link from '@mui/material/Link'
import ReportDashboardPage from 'src/views/linkedin/components/ReportDashboardPage'
import { fetchForgottenLeads } from 'src/services/linkedinService'

const SERIES = [{ key: 'count', label: 'Forgotten Leads', color: '#ff2a5f' }]
const SERIES_KEYS = SERIES.map(s => s.key)

const mapRow = r => ({
  id: r.id,
  owner: r.user?.name ?? '—',
  name: r.name ?? '—',
  company: r.company ?? '—',
  leadStatus: r.leadStatus ?? '—',
  profileUrl: r.profileUrl
})

const fetchRows = params =>
  fetchForgottenLeads({
    page: params.page,
    limit: params.limit,
    userIds: params.userIds
  })

const COLUMNS = [
  { key: 'owner', label: 'Owner' },
  { key: 'name', label: 'Contact Name' },
  { key: 'company', label: 'Company' },
  { key: 'leadStatus', label: 'Lead Status' },
  {
    key: 'profile',
    label: 'HubSpot Profile',
    render: r => (
      <Link href={r.profileUrl} target='_blank' rel='noreferrer'>
        View
      </Link>
    )
  }
]

const LinkedinForgottenLeadsView = () => (
  <ReportDashboardPage
    title='Forgotten Active Leads'
    series={SERIES}
    seriesKeys={SERIES_KEYS}
    summaryTotalsField='forgottenLeadsSeries'
    summaryByOwnerField='forgottenLeadsSeriesByOwner'
    fetchRows={fetchRows}
    mapRow={mapRow}
    columns={COLUMNS}
    searchable={false}
  />
)

export default LinkedinForgottenLeadsView
```

Note: `summaryByOwnerAccountField` is intentionally omitted (left `undefined`) — this report has no LinkedIn-account dimension (a HubSpot lead isn't tied to a LinkedIn account), so the chart's hover popup will show no per-account breakdown, which `ReportDashboardPage`/`StackedOwnerBarChart` already handle gracefully for an empty/undefined `dataByOwnerAccount` (verify this visually in Step 3 below — if the hover popup errors instead of just omitting the breakdown, that's a pre-existing gap in `StackedOwnerBarChart` to patch, not a sign this report is wired wrong).

- [ ] **Step 2: Write the route wrapper**

Create `D:/Techeniac Projects 2/linkedin/frontend/src/pages/linkedin/forgotten-leads/index.js`:

```javascript
import LinkedinForgottenLeadsView from 'src/views/linkedin/forgotten-leads'
import LinkedinAuthGuard from 'src/components/linkedin/LinkedinAuthGuard'

const LinkedinForgottenLeads = () => (
  <LinkedinAuthGuard>
    <LinkedinForgottenLeadsView />
  </LinkedinAuthGuard>
)

// Skips the Techeniac AuthGuard (different server) — gated by LinkedinAuthGuard instead.
LinkedinForgottenLeads.authGuard = false

export default LinkedinForgottenLeads
```

- [ ] **Step 3: Add the nav entry**

In `src/navigation/vertical/index.js`, add a 5th child to the "LinkedIn Overview" group (after "Follow-up Tracking", `navigation/vertical/index.js:68-73`):

```javascript
        {
          title: 'Forgotten Active Leads',
          path: '/linkedin/forgotten-leads',
          icon: 'tabler-user-off',
          auth: false
        }
```

- [ ] **Step 4: Verify**

Run `npm run dev` in `frontend/`, log into the LinkedIn dashboard, navigate to `/linkedin/forgotten-leads` via the new sidebar entry. Confirm: the page loads without console errors, the chart renders a stacked bar (or an empty-state, if no snapshot exists yet for today — refresh once the backend's first `/summary` call for today has completed), the table lists contacts with working "View" links to HubSpot, and the Sales Person filter narrows both the chart and the table.

- [ ] **Step 5: Commit**

```bash
git add src/views/linkedin/forgotten-leads src/pages/linkedin/forgotten-leads src/navigation/vertical/index.js
git commit -m "feat: add Forgotten Active Leads report page"
```

---

## Self-Review Notes

- **Spec coverage**: all 3 filter conditions → Task 4 (`buildFilterGroups`). Owner-awareness (CEO's accountability requirement) → Task 6/7's owner-scoped snapshots + `getSeriesByOwner` + per-row `user.name` in the table. No-cron constraint → Task 6's `ensureTodaySnapshots` lazy pattern, triggered from Task 7's `getSummary`. Trend-over-time (not just a live count) → Task 5's `getSeries`/`getSeriesByOwner` backed by the daily snapshot table. Visualization choice (stacked-by-owner bar, reusing existing chart) → Task 9.
- **Known open risk, not blocking**: Task 1 must run against the real portal before Task 3's defaults can be trusted — if the portal's real property names differ from the guessed defaults, `countForgottenLeads`/`searchForgottenLeads` would silently return 0 or error (HubSpot 400s on an unknown property name) rather than counting anything. Task 7 Step 4's manual `curl` check is the backstop that catches this before it ships.
- **Known scope cut**: the table has no date-range/search/sort — deliberate, since a HubSpot contact's current state carries no timestamp to filter by (unlike the other 4 tables, which all window by an event's `occurredAt`). If a future request wants sorting by e.g. lead-creation date, extend `searchForgottenLeads`'s `sorts` param and thread a `sortBy` through `ForgottenLeadService.list`/`getForgottenLeads` — not built now (YAGNI).
