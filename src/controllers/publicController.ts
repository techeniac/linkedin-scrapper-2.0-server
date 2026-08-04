import { Request, Response, NextFunction } from "express";
import { ConnectionRequestStatus } from "@prisma/client";
import { ConnectionService } from "../services/connectionService";
import { ConnectionEventService } from "../services/connectionEventService";
import { MessageActivityService } from "../services/messageActivityService";
import { MessageEventService } from "../services/messageEventService";
import { LateMessageService } from "../services/lateMessageService";
import { MissedFollowUpService } from "../services/missedFollowUpService";
import {
  getConnectedOwners,
  getConnectedOwnerIds,
  getConnectedOwnerNameMap,
} from "../services/hubspotOwnersService";
import prisma from "../config/prisma";
import { successResponse } from "../utils/apiResponse";

type LinkedinAccount = { id: string; name: string | null };

// Distinct logged-in LinkedIn accounts (the actor on connections / self on
// messages) across the given owners — powers the "LinkedIn account" filter.
// Two DISTINCT scans, so the result is cached (below) rather than run per request.
const loadLinkedinAccounts = async (
  ownerIds: string[],
): Promise<LinkedinAccount[]> => {
  const [actors, selves] = await Promise.all([
    prisma.connectionRequest.findMany({
      where: { userId: { in: ownerIds }, actorLinkedinId: { not: null } },
      select: { actorLinkedinId: true, actorName: true },
      distinct: ["actorLinkedinId"],
    }),
    prisma.messageActivity.findMany({
      where: { userId: { in: ownerIds }, selfLinkedinId: { not: null } },
      select: { selfLinkedinId: true, selfName: true },
      distinct: ["selfLinkedinId"],
    }),
  ]);

  const byId = new Map<string, string | null>();
  const add = (id: string | null, name: string | null) => {
    if (!id) return;
    if (!byId.get(id)) byId.set(id, name ?? byId.get(id) ?? null);
  };
  actors.forEach((a) => add(a.actorLinkedinId, a.actorName));
  selves.forEach((s) => add(s.selfLinkedinId, s.selfName));

  return Array.from(byId.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
};

// Stale-while-revalidate cache for the LinkedIn-account list (changes rarely).
const LA_TTL_MS = 30 * 60 * 1000;
let laCache: { at: number; data: LinkedinAccount[] } | null = null;
let laInFlight: Promise<LinkedinAccount[]> | null = null;

const refreshLinkedinAccounts = (ownerIds: string[]): Promise<LinkedinAccount[]> => {
  if (!laInFlight) {
    laInFlight = loadLinkedinAccounts(ownerIds)
      .then((data) => {
        laCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        laInFlight = null;
      });
  }
  return laInFlight;
};

const getLinkedinAccounts = async (
  ownerIds: string[],
): Promise<LinkedinAccount[]> => {
  if (!laCache) return refreshLinkedinAccounts(ownerIds); // cold — block once
  if (Date.now() - laCache.at >= LA_TTL_MS) {
    void refreshLinkedinAccounts(ownerIds).catch(() => {}); // stale — refresh in bg
  }
  return laCache.data; // warm — instant
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

// Only allow filtering by an owner who is actually a connected owner.
const pickOwner = (v: unknown, ownerIds: string[]): string | undefined => {
  const id = toStr(v);
  return id && ownerIds.includes(id) ? id : undefined;
};

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
    const linkedinAccounts = await getLinkedinAccounts(owners.map((o) => o.id));
    successResponse(res, { users: owners, linkedinAccounts }, "Filters retrieved");
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
    const ownerIds = owners.map((o) => o.id);
    const userId = pickOwner(req.query.userId, ownerIds);
    const linkedinId = toStr(req.query.linkedinId);

    // Shared scope for the message-derived reports (Late Messages, Missed
    // Follow-Up) — both filter identically, so define once.
    const messageOpts = { userId, restrictUserIds: ownerIds, selfLinkedinId: linkedinId };

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
    ] = await Promise.all([
      // COHORT: of requests sent in each bucket, their status now.
      ConnectionService.getSeries(userId, from, to, ownerIds, linkedinId, granularity),
      // ACTIVITY: what actually happened in each bucket, from the append-only
      // event log. This is the series the Connection Requests report wants —
      // it counts every send (including re-sends) and every expiry at the time
      // it occurred, which the cohort view above cannot do.
      ConnectionEventService.getSeries(from, to, {
        userId,
        restrictUserIds: ownerIds,
        actorLinkedinId: linkedinId,
        granularity,
      }),
      ConnectionEventService.getTotals(from, to, {
        userId,
        restrictUserIds: ownerIds,
        actorLinkedinId: linkedinId,
      }),
      // EVENT LOG, not the conversation-aggregate table: each message is
      // bucketed by when it actually happened, so a long-running conversation's
      // history doesn't all land on the day of its most recent message.
      MessageEventService.getSeries(from, to, {
        userId,
        restrictUserIds: ownerIds,
        selfLinkedinId: linkedinId,
        granularity,
      }),
      // Windowed totals for the report's KPI cards, mirroring connectionsTotals.
      MessageEventService.getTotals(from, to, {
        userId,
        restrictUserIds: ownerIds,
        selfLinkedinId: linkedinId,
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
    ]);

    const lateSeries = LateMessageService.buildSeries(lateRows, granularity);
    const lateTotals = LateMessageService.buildTotals(lateRows);
    // STABLE per-day crossing counts (backlog + resolved-late, unioned — see
    // missedFollowUpService.ts). missedFollowUpNow is a LIVE snapshot derived
    // from the SAME backlog fetch above — no second query needed for it.
    const missedFollowUpSeries = MissedFollowUpService.buildSeries(missedBacklog, missedCrossings, from, to);
    const missedFollowUpNow = missedBacklog.length;

    // Pending is a SNAPSHOT, not a time series — "how many are outstanding
    // right now" — so it comes from current state rather than the event log.
    const pendingNow = await ConnectionService.getStats(userId, ownerIds);

    successResponse(
      res,
      {
        connectionsSeries,
        connectionsActivitySeries,
        connectionsTotals: { ...connectionsTotals, pending: pendingNow.pending },
        messagesSeries,
        messagesTotals,
        lateSeries,
        lateTotals,
        missedFollowUpSeries,
        missedFollowUpNow,
        users: owners,
        linkedinAccounts,
      },
      "Summary retrieved",
    );
  } catch (error) {
    next(error);
  }
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

// The conversationKey is stored as the "2-<threadId>" segment, which is exactly
// LinkedIn's thread-URL slug. Turn it into a deep link to the conversation and
// drop the raw key from the response.
const THREAD_SLUG_RE = /2-[A-Za-z0-9_=-]+/;
const withConversationUrl = (rows: any[]): any[] =>
  rows.map((r) => {
    const { conversationKey, ...rest } = r;
    const slug =
      typeof conversationKey === "string"
        ? conversationKey.match(THREAD_SLUG_RE)?.[0]
        : undefined;
    return {
      ...rest,
      conversationUrl: slug
        ? `https://www.linkedin.com/messaging/thread/${slug}/`
        : null,
    };
  });

// GET /api/public/connections — connected owners only, HubSpot names.
export const getConnections = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const [ownerIds, nameMap] = await Promise.all([
      getConnectedOwnerIds(),
      getConnectedOwnerNameMap(),
    ]);
    const userId = pickOwner(req.query.userId, ownerIds);

    const statusRaw = toStr(req.query.status)?.toUpperCase();
    const status =
      statusRaw && statusRaw in ConnectionRequestStatus
        ? (statusRaw as ConnectionRequestStatus)
        : undefined;

    const result = await ConnectionService.list({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      sortBy: toStr(req.query.sortBy),
      sortOrder: toSortOrder(req.query.sortOrder),
      search: toStr(req.query.search),
      userId,
      userIds: userId ? undefined : ownerIds,
      actorLinkedinId: toStr(req.query.linkedinId),
      status,
      sentFrom: toDate(req.query.sentFrom),
      sentTo: toDate(req.query.sentTo),
    });

    successResponse(
      res,
      { data: withOwnerName(result.data as any[], nameMap), metadata: result.metadata },
      "Connections retrieved",
    );
  } catch (error) {
    next(error);
  }
};

// GET /api/public/messages — connected owners only, HubSpot names.
export const getMessages = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const [ownerIds, nameMap] = await Promise.all([
      getConnectedOwnerIds(),
      getConnectedOwnerNameMap(),
    ]);
    const userId = pickOwner(req.query.userId, ownerIds);

    const result = await MessageActivityService.list({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      sortBy: toStr(req.query.sortBy),
      sortOrder: toSortOrder(req.query.sortOrder),
      search: toStr(req.query.search),
      userId,
      userIds: userId ? undefined : ownerIds,
      selfLinkedinId: toStr(req.query.linkedinId),
      hasReply: toBool(req.query.hasReply),
      isConversation: toBool(req.query.isConversation),
      lastFrom: toDate(req.query.lastFrom),
      lastTo: toDate(req.query.lastTo),
    });

    successResponse(
      res,
      {
        data: withConversationUrl(withOwnerName(result.data as any[], nameMap)),
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
    const userId = pickOwner(req.query.userId, ownerIds);

    const result = await LateMessageService.list({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      userId,
      userIds: userId ? undefined : ownerIds,
      selfLinkedinId: toStr(req.query.linkedinId),
      from,
      to,
    });

    // Table columns: Name | LinkedIn URL | Sales Person | LinkedIn Profile.
    const data = result.data.map((r) => ({
      name: r.participantName,
      linkedinUrl: r.participantProfileUrl,
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
// current backlog. Not windowed by date: message_events is immutable, so
// this answers the same regardless of when you ask. Query: userId?,
// linkedinId?, page?, limit?.
export const getMissedFollowUps = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const now = new Date();
    const [ownerIds, nameMap] = await Promise.all([
      getConnectedOwnerIds(),
      getConnectedOwnerNameMap(),
    ]);
    const userId = pickOwner(req.query.userId, ownerIds);

    const result = await MissedFollowUpService.listHistory({
      page: toInt(req.query.page, 1),
      limit: toInt(req.query.limit, 10),
      userId,
      userIds: userId ? undefined : ownerIds,
      selfLinkedinId: toStr(req.query.linkedinId),
      now,
    });

    // Table columns: Name | LinkedIn URL | Sales Person | LinkedIn Profile,
    // plus Status | Missed Since | Follow-Up Sent | Days Late for the history.
    const data = result.data.map((r) => ({
      name: r.participantName,
      linkedinUrl: r.participantProfileUrl,
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
