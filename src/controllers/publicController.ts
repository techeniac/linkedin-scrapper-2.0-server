import { Request, Response, NextFunction } from "express";
import { ConnectionRequestStatus } from "@prisma/client";
import { ConnectionService } from "../services/connectionService";
import { MessageActivityService } from "../services/messageActivityService";
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

    const [connectionsSeries, messagesSeries, linkedinAccounts] =
      await Promise.all([
        ConnectionService.getSeries(userId, from, to, ownerIds, linkedinId, granularity),
        MessageActivityService.getSeries(userId, from, to, ownerIds, linkedinId, granularity),
        getLinkedinAccounts(ownerIds),
      ]);

    successResponse(
      res,
      { connectionsSeries, messagesSeries, users: owners, linkedinAccounts },
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
