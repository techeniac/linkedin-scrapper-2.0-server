import { Request, Response, NextFunction } from "express";
import { ConnectionRequestStatus } from "@prisma/client";
import { ConnectionService } from "../services/connectionService";
import { ConnectionEventService } from "../services/connectionEventService";
import { MessageEventService } from "../services/messageEventService";
import { LateMessageService } from "../services/lateMessageService";
import { MissedFollowUpService } from "../services/missedFollowUpService";
import { ForgottenLeadService } from "../services/forgottenLeadService";
import { HubSpotContactService } from "../services/hubspotContactService";
import { HubSpotOAuthService } from "../services/hubspotOAuthService";
import {
  getConnectedOwners,
  getConnectedOwnerIds,
  getConnectedOwnerNameMap,
} from "../services/hubspotOwnersService";
import prisma from "../config/prisma";
import { successResponse, errorResponse } from "../utils/apiResponse";

type LinkedinAccount = { id: string; name: string | null };
// Distinct (ownerId, linkedinAccountId) pairs — "which accounts has this
// owner actually used" — powers the frontend's cascading Group-By filter
// (narrowing the secondary dropdown to only what co-occurs with the primary
// selection). Computed from the SAME two scans as the account list below, so
// this never costs a third DISTINCT query.
type OwnerAccountPair = { ownerId: string; linkedinAccountId: string };

// Distinct logged-in LinkedIn accounts (the actor on connections / self on
// messages) across the given owners — powers the "LinkedIn account" filter.
// Two DISTINCT scans, so the result is cached (below) rather than run per request.
const loadLinkedinAccounts = async (
  ownerIds: string[],
): Promise<{ accounts: LinkedinAccount[]; pairs: OwnerAccountPair[] }> => {
  const [actors, selves] = await Promise.all([
    prisma.connectionRequest.findMany({
      where: { userId: { in: ownerIds }, actorLinkedinId: { not: null } },
      select: { userId: true, actorLinkedinId: true, actorName: true },
      distinct: ["userId", "actorLinkedinId"],
    }),
    prisma.messageActivity.findMany({
      where: { userId: { in: ownerIds }, selfLinkedinId: { not: null } },
      select: { userId: true, selfLinkedinId: true, selfName: true },
      distinct: ["userId", "selfLinkedinId"],
    }),
  ]);

  const byId = new Map<string, string | null>();
  const add = (id: string | null, name: string | null) => {
    if (!id) return;
    if (!byId.get(id)) byId.set(id, name ?? byId.get(id) ?? null);
  };
  actors.forEach((a) => add(a.actorLinkedinId, a.actorName));
  selves.forEach((s) => add(s.selfLinkedinId, s.selfName));

  const pairKeys = new Set<string>();
  const pairs: OwnerAccountPair[] = [];
  const addPair = (ownerId: string, accountId: string | null) => {
    if (!accountId) return;
    const key = `${ownerId}:${accountId}`;
    if (pairKeys.has(key)) return;
    pairKeys.add(key);
    pairs.push({ ownerId, linkedinAccountId: accountId });
  };
  actors.forEach((a) => addPair(a.userId, a.actorLinkedinId));
  selves.forEach((s) => addPair(s.userId, s.selfLinkedinId));

  return {
    accounts: Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    pairs,
  };
};

// Stale-while-revalidate cache for the LinkedIn-account list (changes rarely).
const LA_TTL_MS = 30 * 60 * 1000;
let laCache: { at: number; accounts: LinkedinAccount[]; pairs: OwnerAccountPair[] } | null = null;
let laInFlight: Promise<{ accounts: LinkedinAccount[]; pairs: OwnerAccountPair[] }> | null = null;

const refreshLinkedinAccounts = (
  ownerIds: string[],
): Promise<{ accounts: LinkedinAccount[]; pairs: OwnerAccountPair[] }> => {
  if (!laInFlight) {
    laInFlight = loadLinkedinAccounts(ownerIds)
      .then((data) => {
        laCache = { at: Date.now(), ...data };
        return data;
      })
      .finally(() => {
        laInFlight = null;
      });
  }
  return laInFlight;
};

const getLinkedinAccountsData = async (
  ownerIds: string[],
): Promise<{ accounts: LinkedinAccount[]; pairs: OwnerAccountPair[] }> => {
  if (!laCache) return refreshLinkedinAccounts(ownerIds); // cold — block once
  if (Date.now() - laCache.at >= LA_TTL_MS) {
    void refreshLinkedinAccounts(ownerIds).catch(() => {}); // stale — refresh in bg
  }
  return laCache; // warm — instant
};

const getLinkedinAccounts = async (ownerIds: string[]): Promise<LinkedinAccount[]> =>
  (await getLinkedinAccountsData(ownerIds)).accounts;

// "Connected On" option list for the Forgotten Active Leads report's filter —
// HubSpot's `contact_source` property (which rep's LinkedIn profile sourced
// a contact; already surfaced elsewhere in this codebase under the same
// "connectedOnSource" name — see hubspotContactService.ts's
// getPropertyOptions/findContactByProfileUrl). Portal-specific and mutable
// (a new rep = a new option), so fetched from HubSpot rather than hardcoded,
// same stale-while-revalidate cache shape as the LinkedIn-accounts cache
// above — any one connected owner's token is enough, since this is a
// portal-wide property definition, not per-owner data.
type FilterOption = { value: string; label: string };
const CO_TTL_MS = 30 * 60 * 1000;
let coCache: { at: number; options: FilterOption[] } | null = null;
let coInFlight: Promise<FilterOption[]> | null = null;

// Throws (does not swallow) on failure — matches loadLinkedinAccounts above:
// a failed load must never get written into coCache as a false "there are no
// sources" answer, so the next request retries instead of the filter staying
// empty for a full CO_TTL_MS. Tries every connected owner in turn (not just
// the first) since this is a single portal-wide property definition — any
// one owner's valid token is enough, so one owner's revoked token shouldn't
// fail the whole lookup while others are still connected.
const loadConnectedOnSources = async (ownerIds: string[]): Promise<FilterOption[]> => {
  if (!ownerIds.length) return [];
  let lastErr: unknown;
  for (const ownerId of ownerIds) {
    try {
      const token = await HubSpotOAuthService.getValidAccessToken(ownerId);
      const service = new HubSpotContactService("https://api.hubapi.com", {
        Authorization: `Bearer ${token}`,
      });
      const { connectedOnSources } = await service.getPropertyOptions();
      return connectedOnSources;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
};

const refreshConnectedOnSources = (ownerIds: string[]): Promise<FilterOption[]> => {
  if (!coInFlight) {
    coInFlight = loadConnectedOnSources(ownerIds)
      .then((options) => {
        coCache = { at: Date.now(), options };
        return options;
      })
      .finally(() => {
        coInFlight = null;
      });
  }
  return coInFlight;
};

const getConnectedOnSources = async (ownerIds: string[]): Promise<FilterOption[]> => {
  if (!coCache) return refreshConnectedOnSources(ownerIds); // cold — block once
  if (Date.now() - coCache.at >= CO_TTL_MS) {
    void refreshConnectedOnSources(ownerIds).catch(() => {}); // stale — refresh in bg
  }
  return coCache.options; // warm — instant
};

// These endpoints are intentionally UNAUTHENTICATED (see publicRoutes.ts): they
// serve read-only reporting data to the Chitragupt frontend (no login yet).
// Scope is limited to HubSpot-CONNECTED owners only, and owner names come from
// HubSpot (not our users table).

// --- query param parsers ---
const toInt = (v: unknown, def: number): number => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
};
const toStr = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
};
const toDate = (v: unknown): Date | undefined => {
  const s = toStr(v);
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
};
const toBool = (v: unknown): boolean | undefined => {
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
};
const toSortOrder = (v: unknown): "asc" | "desc" =>
  toStr(v) === "asc" ? "asc" : "desc";

// Accepts either repeated query params (?ids=a&ids=b), a comma-separated
// value (?ids=a,b), or a single value — Express gives an array for the first
// form and a string for the other two.
const toStrArray = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return raw.map((s) => String(s).trim()).filter(Boolean);
};

// Only allow filtering by an owner who is actually a connected owner.
const pickOwner = (v: unknown, ownerIds: string[]): string | undefined => {
  const id = toStr(v);
  return id && ownerIds.includes(id) ? id : undefined;
};

// Multi-select counterpart to pickOwner — every requested id must be a real
// connected owner, or it's silently dropped (never lets a caller probe an
// arbitrary user id through this public, unauthenticated router).
const pickOwners = (v: unknown, ownerIds: string[]): string[] =>
  toStrArray(v).filter((id) => ownerIds.includes(id));

const DAY_MS = 24 * 60 * 60 * 1000;

// Per-granularity window caps (defensive; the client enforces the exact limit).
//  - day  : 90 days  - week : 24 weeks  - month: 24 months (~31d each)
const RANGE_CAP_MS: Record<"day" | "week" | "month", number> = {
  day: 90 * DAY_MS,
  week: 24 * 7 * DAY_MS,
  month: 24 * 31 * DAY_MS,
};

const toGranularity = (v: unknown): "day" | "week" | "month" => {
  const s = toStr(v);
  return s === "week" || s === "month" ? s : "day";
};

// GET /api/public/filters — just the dropdown option lists (connected owners +
// LinkedIn accounts), both cached. Lets the Connections/Messages tables load
// their filters WITHOUT triggering the summary's two chart-series aggregations.
export const getFilters = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const owners = await getConnectedOwners();
    const ownerIds = owners.map((o) => o.id);
    const { accounts: linkedinAccounts, pairs: ownerAccounts } = await getLinkedinAccountsData(ownerIds);
    // A cold-start failure here must degrade to an empty list for THIS
    // response only — not throw and 500 the whole /public/filters endpoint
    // (which every report's toolbar depends on), and not get cached as a
    // false "there are no sources" answer (loadConnectedOnSources already
    // guarantees a failure never reaches coCache; see its own comment).
    const connectedOnSources = await getConnectedOnSources(ownerIds).catch(() => []);
    successResponse(
      res,
      { users: owners, linkedinAccounts, ownerAccounts, connectedOnSources },
      "Filters retrieved",
    );
  } catch (error) {
    next(error);
  }
};

// GET /api/public/summary — per-day connection & message series for the charts,
// plus the connected-owner list. Query: from?, to? (ISO), userId?.
// The [from, to] window is capped at 60 days (defensively clamped here too).
export const getSummary = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const now = new Date();
    const granularity = toGranularity(req.query.granularity);
    let to = toDate(req.query.to) ?? now;
    let from = toDate(req.query.from) ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from > to) [from, to] = [to, from];
    // Enforce the per-granularity window cap (also validated on the client).
    const cap = RANGE_CAP_MS[granularity];
    if (to.getTime() - from.getTime() > cap) {
      from = new Date(to.getTime() - cap);
    }

    const owners = await getConnectedOwners();
    // Lazy daily snapshot — see ForgottenLeadService for why this replaces a
    // cron job. Cheap on every call after the first per owner per UTC day
    // (a single indexed existence check); only calls HubSpot when a day's
    // snapshot is genuinely missing.
    await ForgottenLeadService.ensureTodaySnapshots(
      owners.map((o) => ({ id: o.id, hubspotOwnerId: o.hubspotOwnerId })),
    );
    const ownerIds = owners.map((o) => o.id);
    const userId = pickOwner(req.query.userId, ownerIds);
    const linkedinId = toStr(req.query.linkedinId);
    const linkedinIds = toStrArray(req.query.linkedinAccountIds);

    // Connections report's multi-select Status filter — narrows the chart to
    // a set of statuses' activity (see
    // ConnectionEventService.getSeries/getSeriesByOwner). Only ever affects
    // the connections series; every other report's series ignores it.
    const connectionStatuses = toStrArray(req.query.connectionStatuses)
      .map((s) => s.toUpperCase())
      .filter((s): s is ConnectionRequestStatus => s in ConnectionRequestStatus);

    // Multi-select owner breakdown — see the 4 services' getSeriesByOwner /
    // buildSeriesByOwner. Opt-in: only requested (and only computed) when the
    // client actually asks for it, so the common single/no-owner case never
    // pays for the extra grouping.
    const breakdownOwnerIds = pickOwners(req.query.ownerIds, ownerIds);

    // The SAME owner selection the client sent (breakdownOwnerIds) must also
    // scope every totals/non-split series query below — not just the ByOwner
    // ones. Previously the totals queries used the unfiltered `ownerIds` (ALL
    // connected owners) regardless of which owners the user had filtered to,
    // so the number printed above each bar (and the KPI totals) silently
    // reflected the whole company while the plotted segments reflected only
    // the filtered subset — e.g. a bar showing one owner's "4" underneath a
    // total of "8" from other, hidden owners. Falls back to every connected
    // owner only when the client didn't request a specific scope at all.
    const ownerScope = breakdownOwnerIds.length ? breakdownOwnerIds : ownerIds;

    // Shared scope for the message-derived reports (Late Messages, Missed
    // Follow-Up) — both filter identically, so define once.
    const messageOpts = {
      userId,
      restrictUserIds: ownerScope,
      selfLinkedinId: linkedinId,
      selfLinkedinIds: linkedinIds,
    };

    const [
      connectionsSeries,
      connectionsActivitySeries,
      connectionsTotals,
      messagesSeries,
      messagesTotals,
      lateRows,
      missedBacklog,
      missedCrossings,
      linkedinAccounts,
      connectionsActivitySeriesByOwner,
      messagesSeriesByOwner,
      connectionsActivitySeriesByOwnerAccount,
      messagesSeriesByOwnerAccount,
      forgottenLeadsSeries,
      forgottenLeadsSeriesByOwner,
    ] = await Promise.all([
      // COHORT: of requests sent in each bucket, their status now.
      ConnectionService.getSeries(userId, from, to, ownerScope, linkedinId, granularity),
      // ACTIVITY: what actually happened in each bucket, from the append-only
      // event log. This is the series the Connection Requests report wants —
      // it counts every send (including re-sends) and every expiry at the time
      // it occurred, which the cohort view above cannot do.
      ConnectionEventService.getSeries(from, to, {
        userId,
        restrictUserIds: ownerScope,
        actorLinkedinId: linkedinId,
        actorLinkedinIds: linkedinIds,
        granularity,
        statuses: connectionStatuses.length ? connectionStatuses : undefined,
      }),
      ConnectionEventService.getTotals(from, to, {
        userId,
        restrictUserIds: ownerScope,
        actorLinkedinId: linkedinId,
        actorLinkedinIds: linkedinIds,
      }),
      // EVENT LOG, not the conversation-aggregate table: each message is
      // bucketed by when it actually happened, so a long-running conversation's
      // history doesn't all land on the day of its most recent message.
      MessageEventService.getSeries(from, to, {
        userId,
        restrictUserIds: ownerScope,
        selfLinkedinId: linkedinId,
        selfLinkedinIds: linkedinIds,
        granularity,
      }),
      // Windowed totals for the report's KPI cards, mirroring connectionsTotals.
      MessageEventService.getTotals(from, to, {
        userId,
        restrictUserIds: ownerScope,
        selfLinkedinId: linkedinId,
        selfLinkedinIds: linkedinIds,
      }),
      // Late Messages report: fetched ONCE here — series and totals are both
      // pure derivations of the same row set (see buildSeries/buildTotals
      // below), rather than each independently re-querying for the identical
      // window and filters.
      LateMessageService.getLateRows(from, to, messageOpts),
      // Missed Follow-Up report: same principle — the backlog (STILL_MISSING)
      // and the resolved-late crossings are each fetched exactly once, then
      // reused for both the chart series AND the live KPI count below.
      MissedFollowUpService.getBacklog(messageOpts, now),
      LateMessageService.getFollowUpDeadlineCrossings(from, to, messageOpts),
      getLinkedinAccounts(ownerIds),
      // Per-owner breakdown for the report chart's stacked segments — only
      // actually queried when the client asked for a breakdown (see
      // breakdownOwnerIds above); each ByOwner method itself already
      // short-circuits to [] on an empty id list, so this never adds a real
      // query to the common case.
      ConnectionEventService.getSeriesByOwner(from, to, breakdownOwnerIds, {
        actorLinkedinId: linkedinId,
        actorLinkedinIds: linkedinIds,
        granularity,
        statuses: connectionStatuses.length ? connectionStatuses : undefined,
      }),
      MessageEventService.getSeriesByOwner(from, to, breakdownOwnerIds, {
        selfLinkedinId: linkedinId,
        selfLinkedinIds: linkedinIds,
        granularity,
      }),
      // Per-(owner, LinkedIn account) breakdown for the chart hover popup —
      // same opt-in short-circuit as the per-owner queries above.
      ConnectionEventService.getSeriesByOwnerAccount(from, to, breakdownOwnerIds, {
        actorLinkedinId: linkedinId,
        actorLinkedinIds: linkedinIds,
        granularity,
        statuses: connectionStatuses.length ? connectionStatuses : undefined,
      }),
      MessageEventService.getSeriesByOwnerAccount(from, to, breakdownOwnerIds, {
        selfLinkedinId: linkedinId,
        selfLinkedinIds: linkedinIds,
        granularity,
      }),
      ForgottenLeadService.getSeries(from, to, {
        userId,
        restrictUserIds: ownerScope,
        granularity,
      }),
      ForgottenLeadService.getSeriesByOwner(from, to, breakdownOwnerIds, { granularity }),
    ]);

    const lateSeries = LateMessageService.buildSeries(lateRows, granularity);
    const lateTotals = LateMessageService.buildTotals(lateRows);
    // STABLE per-day crossing counts (backlog + resolved-late, unioned — see
    // missedFollowUpService.ts). missedFollowUpNow is a LIVE snapshot derived
    // from the SAME backlog fetch above — no second query needed for it.
    const missedFollowUpSeries = MissedFollowUpService.buildSeries(missedBacklog, missedCrossings, from, to);
    const missedFollowUpNow = missedBacklog.length;

    // Same per-owner breakdown principle for Late Messages / Missed Follow-Up
    // — both are pure re-aggregations of the rows already fetched above, so
    // this is free (no additional DB round trip) regardless of whether a
    // breakdown was requested.
    const lateSeriesByOwner = LateMessageService.buildSeriesByOwner(lateRows, breakdownOwnerIds, granularity);
    const missedFollowUpSeriesByOwner = MissedFollowUpService.buildSeriesByOwner(
      missedBacklog,
      missedCrossings,
      breakdownOwnerIds,
      from,
      to,
    );
    const lateSeriesByOwnerAccount = LateMessageService.buildSeriesByOwnerAccount(
      lateRows,
      breakdownOwnerIds,
      granularity,
    );
    const missedFollowUpSeriesByOwnerAccount = MissedFollowUpService.buildSeriesByOwnerAccount(
      missedBacklog,
      missedCrossings,
      breakdownOwnerIds,
      from,
      to,
    );

    // Pending is a SNAPSHOT, not a time series — "how many are outstanding
    // right now" — so it comes from current state rather than the event log.
    const pendingNow = await ConnectionService.getStats(userId, ownerScope);
    const forgottenLeadsTotal = await ForgottenLeadService.getTotal(ownerScope);

    successResponse(
      res,
      {
        connectionsSeries,
        connectionsActivitySeries,
        connectionsActivitySeriesByOwner,
        connectionsActivitySeriesByOwnerAccount,
        connectionsTotals: { ...connectionsTotals, pending: pendingNow.pending },
        messagesSeries,
        messagesSeriesByOwner,
        messagesSeriesByOwnerAccount,
        messagesTotals,
        lateSeries,
        lateSeriesByOwner,
        lateSeriesByOwnerAccount,
        lateTotals,
        missedFollowUpSeries,
        missedFollowUpSeriesByOwner,
        missedFollowUpSeriesByOwnerAccount,
        missedFollowUpNow,
        forgottenLeadsSeries,
        forgottenLeadsSeriesByOwner,
        forgottenLeadsTotal,
        users: owners,
        linkedinAccounts,
      },
      "Summary retrieved",
    );
  } catch (error) {
    next(error);
  }
};

// Resolves the owner scope for a list endpoint: a single validated userId
// (from ?userId), else a validated multi-select subset (from ?userIds), else
// every connected owner (today's existing "no filter" behaviour).
const resolveOwnerScope = (
  req: Request,
  ownerIds: string[],
): { userId: string | undefined; userIds: string[] | undefined } => {
  const userId = pickOwner(req.query.userId, ownerIds);
  if (userId) return { userId, userIds: undefined };
  const userIds = pickOwners(req.query.userIds, ownerIds);
  return { userId: undefined, userIds: userIds.length > 0 ? userIds : ownerIds };
};

// Same shape for the LinkedIn-account dimension: a single value (?linkedinId)
// takes precedence over a multi-select (?linkedinAccountIds); neither means
// no account filter at all (not validated against a master list, same as the
// existing singular-only behaviour — these only ever narrow an already
// owner-scoped query).
const resolveAccountScope = (
  req: Request,
): { accountId: string | undefined; accountIds: string[] | undefined } => {
  const accountId = toStr(req.query.linkedinId);
  if (accountId) return { accountId, accountIds: undefined };
  const accountIds = toStrArray(req.query.linkedinAccountIds);
  return { accountId: undefined, accountIds: accountIds.length > 0 ? accountIds : undefined };
};

// The conversationKey is stored as the "2-<threadId>" segment, which is
// exactly LinkedIn's thread-URL slug. Turns it into a deep link to the
// conversation on LinkedIn's own site. Used by the Messages, Late Responses,
// and Follow-up Tracking reports' "Conversation" link — deliberately the
// conversation, not the contact's profile, per explicit request. NOTE: this
// only opens correctly for a viewer logged into the exact LinkedIn account
// that sent/received these messages; it fails for anyone else (the same
// limitation the in-app MessageThreadDialog popup was built to avoid).
const THREAD_SLUG_RE = /2-[A-Za-z0-9_=-]+/;
const conversationUrlFromKey = (conversationKey: unknown): string | null => {
  const slug = typeof conversationKey === "string" ? conversationKey.match(THREAD_SLUG_RE)?.[0] : undefined;
  return slug ? `https://www.linkedin.com/messaging/thread/${slug}/` : null;
};

// Replace each row's owner name with the HubSpot name (fallback to DB name).
const withOwnerName = (
  rows: any[],
  nameMap: Map<string, string | null>,
): any[] =>
  rows.map((r) => {
    const { userId, user, ...rest } = r;
    return { ...rest, user: { name: nameMap.get(userId) ?? user?.name ?? null } };
  });

// GET /api/public/connections — connected owners only, HubSpot names.
// Windowed by from?/to? (ISO, defaults to the same 30-day window as
// /summary) over occurredAt — one row per (target, status transition) from
// the append-only event log, so every row here always has a matching bar on
// the report's chart. See ConnectionEventService.list for why this replaced
// the old current-state-table listing.
export const getConnections = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const now = new Date();
    let to = toDate(req.query.to) ?? now;
    let from = toDate(req.query.from) ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from > to) [from, to] = [to, from];
    const [ownerIds, nameMap] = await Promise.all([
      getConnectedOwnerIds(),
      getConnectedOwnerNameMap(),
    ]);
    const { userId, userIds } = resolveOwnerScope(req, ownerIds);
    const { accountId, accountIds } = resolveAccountScope(req);

    const statuses = toStrArray(req.query.statuses)
      .map((s) => s.toUpperCase())
      .filter((s): s is ConnectionRequestStatus => s in ConnectionRequestStatus);

    const result = await ConnectionEventService.list({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      sortBy: toStr(req.query.sortBy),
      sortOrder: toSortOrder(req.query.sortOrder),
      search: toStr(req.query.search),
      userId,
      userIds,
      actorLinkedinId: accountId,
      actorLinkedinIds: accountIds,
      statuses: statuses.length ? statuses : undefined,
      from,
      to,
    });

    // Table columns: Owner | LinkedIn Profile | Contact Name | Status | Date |
    // Profile. `status`/`date` here name the specific TRANSITION this row is
    // (toStatus/occurredAt), not a request's current lifecycle state.
    const data = (result.data as any[]).map((r) => ({
      id: r.id,
      userId: r.userId,
      user: r.user,
      linkedinProfile: r.actorName,
      contactName: r.targetName,
      status: r.toStatus,
      date: r.occurredAt,
      profileUrl: r.targetProfileUrl,
    }));

    successResponse(
      res,
      { data: withOwnerName(data, nameMap), metadata: result.metadata },
      "Connections retrieved",
    );
  } catch (error) {
    next(error);
  }
};

// GET /api/public/messages — connected owners only, HubSpot names. Windowed
// by from?/to? (ISO, defaults to the same 30-day window as /summary) over
// occurredAt — one row per (kind, conversation, day) from the event log, so
// every row here always has a matching bar on the report's chart. See
// MessageEventService.list for why this replaced the old conversation-
// aggregate listing (MessageActivityService.list). Returns
// `conversationUrl` (see conversationUrlFromKey) for the "Conversation" link
// — not a profile URL.
export const getMessages = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const now = new Date();
    let to = toDate(req.query.to) ?? now;
    let from = toDate(req.query.from) ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from > to) [from, to] = [to, from];
    const [ownerIds, nameMap] = await Promise.all([
      getConnectedOwnerIds(),
      getConnectedOwnerNameMap(),
    ]);
    const { userId, userIds } = resolveOwnerScope(req, ownerIds);
    const { accountId, accountIds } = resolveAccountScope(req);
    const kindRaw = toStr(req.query.kind)?.toUpperCase();
    const kind =
      kindRaw === "FRESH" || kindRaw === "FOLLOW_UP" || kindRaw === "REPLIED" ? kindRaw : undefined;

    const result = await MessageEventService.list({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      userId,
      userIds,
      selfLinkedinId: accountId,
      selfLinkedinIds: accountIds,
      kind,
      from,
      to,
    });

    const data = result.data.map((r) => ({
      id: `${r.userId}:${r.conversationKey}:${r.kind}:${r.occurredAt.toISOString().slice(0, 10)}`,
      userId: r.userId,
      conversationKey: r.conversationKey,
      conversationUrl: conversationUrlFromKey(r.conversationKey),
      kind: r.kind,
      occurredAt: r.occurredAt,
      participantName: r.participantName,
      selfName: r.selfName,
    }));

    successResponse(
      res,
      {
        data: withOwnerName(data, nameMap),
        metadata: result.metadata,
      },
      "Messages retrieved",
    );
  } catch (error) {
    next(error);
  }
};

// GET /api/public/late-messages — supporting table for the Late Messages
// report: one row per conversation (deduped to its most recent late instance
// in the window). Query: from?, to? (ISO, defaults to the same 30-day window
// as /summary), userId?, linkedinId?.
export const getLateMessages = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const now = new Date();
    let to = toDate(req.query.to) ?? now;
    let from = toDate(req.query.from) ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from > to) [from, to] = [to, from];
    // Defensive cap: list() must fetch every matching row (lateness can only
    // be judged after computing it, before pagination), unlike the other list
    // endpoints which can page at the DB level. Same 90-day cap as /summary's
    // day granularity.
    if (to.getTime() - from.getTime() > RANGE_CAP_MS.day) {
      from = new Date(to.getTime() - RANGE_CAP_MS.day);
    }

    const [ownerIds, nameMap] = await Promise.all([
      getConnectedOwnerIds(),
      getConnectedOwnerNameMap(),
    ]);
    const { userId, userIds } = resolveOwnerScope(req, ownerIds);
    const { accountId, accountIds } = resolveAccountScope(req);
    const kindRaw = toStr(req.query.kind)?.toUpperCase();
    const kind = kindRaw === "LATE_REPLY" || kindRaw === "LATE_FOLLOW_UP" ? kindRaw : undefined;

    const result = await LateMessageService.list({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      userId,
      userIds,
      selfLinkedinId: accountId,
      selfLinkedinIds: accountIds,
      kind,
      from,
      to,
    });

    // Table columns: Name | Conversation | Sales Person | LinkedIn Profile.
    // `id` is synthesized (this report has no single-row primary key of its
    // own — a late instance is identified by which conversation, for which
    // owner) so the frontend has a stable React key. `conversationUrl` (not
    // a profile URL) per explicit request — see conversationUrlFromKey.
    const data = result.data.map((r) => ({
      id: `${r.userId}:${r.conversationKey}:${r.occurredAt.toISOString()}`,
      name: r.participantName,
      conversationUrl: conversationUrlFromKey(r.conversationKey),
      user: { name: nameMap.get(r.userId) ?? null }, // Sales Person
      linkedinProfile: r.selfName, // the rep's own LinkedIn account
      occurredAt: r.occurredAt,
      kind: r.kind,
    }));

    successResponse(res, { data, metadata: result.metadata }, "Late messages retrieved");
  } catch (error) {
    next(error);
  }
};

// GET /api/public/missed-followups — supporting table for the Missed
// Follow-Up report: one row per conversation, showing its current follow-up
// status — still overdue (STILL_MISSING), or resolved but late
// (RESOLVED_LATE) — so an admin can see the full history, not just the
// current backlog. Windowed by deadline over from?/to? (ISO, defaults to the
// same 30-day window as /summary) — same field the chart buckets on, so
// every table row here always has a matching bar on the chart. Query: from?,
// to?, userId?, linkedinId?, page?, limit?.
export const getMissedFollowUps = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const now = new Date();
    let to = toDate(req.query.to) ?? now;
    let from = toDate(req.query.from) ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from > to) [from, to] = [to, from];
    const [ownerIds, nameMap] = await Promise.all([
      getConnectedOwnerIds(),
      getConnectedOwnerNameMap(),
    ]);
    const { userId, userIds } = resolveOwnerScope(req, ownerIds);
    const { accountId, accountIds } = resolveAccountScope(req);
    const statusRaw = toStr(req.query.status)?.toUpperCase();
    const status = statusRaw === "STILL_MISSING" || statusRaw === "RESOLVED_LATE" ? statusRaw : undefined;

    const result = await MissedFollowUpService.listHistory({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      userId,
      userIds,
      selfLinkedinId: accountId,
      selfLinkedinIds: accountIds,
      status,
      from,
      to,
      now,
    });

    // Table columns: Name | Conversation | Sales Person | LinkedIn Profile,
    // plus Status | Missed Since | Follow-Up Sent | Days Late for the history.
    // `id` is synthesized (one row per conversation's CURRENT status, not a
    // single-row primary key) so the frontend has a stable React key.
    // `conversationUrl` (not a profile URL) per explicit request — see
    // conversationUrlFromKey.
    const data = result.data.map((r) => ({
      id: `${r.userId}:${r.conversationKey}`,
      name: r.participantName,
      conversationUrl: conversationUrlFromKey(r.conversationKey),
      user: { name: nameMap.get(r.userId) ?? null }, // Sales Person
      linkedinProfile: r.selfName, // the rep's own LinkedIn account
      status: r.status,
      missedSince: r.missedSince,
      deadline: r.deadline,
      followUpSentAt: r.followUpSentAt,
      daysLate: r.daysLate,
    }));

    successResponse(res, { data, metadata: result.metadata }, "Missed follow-ups retrieved");
  } catch (error) {
    next(error);
  }
};

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
      connectedOnSources: toStrArray(req.query.connectedOnSources),
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
