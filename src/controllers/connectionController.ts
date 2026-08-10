import { Response, NextFunction } from "express";
import { ConnectionRequestStatus } from "@prisma/client";
import { ConnectionService } from "../services/connectionService";
import { ConnectionEventService } from "../services/connectionEventService";
import { successResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import logger from "../utils/logger";

// POST /api/connections/track — record a connection request the user sent
export const trackConnection = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const {
      targetLinkedinId,
      targetProfileUrl,
      targetName,
      actorLinkedinId,
      actorName,
      actorPublicIdentifier,
    } = req.body as {
      targetLinkedinId: string;
      targetProfileUrl?: string;
      targetName?: string;
      actorLinkedinId?: string;
      actorName?: string;
      actorPublicIdentifier?: string;
    };
    logger.info("[CT][api] POST /connections/track", {
      userId,
      targetLinkedinId,
      actorLinkedinId,
    });
    await ConnectionService.trackSent(userId, {
      targetLinkedinId,
      targetProfileUrl,
      targetName,
      actorLinkedinId,
      actorName,
      actorPublicIdentifier,
    });
    logger.info("[CT][api] track stored OK", { userId, targetLinkedinId });
    successResponse(res, null, "Connection request tracked", 201);
  } catch (error: any) {
    next(error);
  }
};

// POST /api/connections/status — reconcile a request to a new lifecycle status
export const updateConnectionStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { targetLinkedinId, status } = req.body as {
      targetLinkedinId: string;
      status: ConnectionRequestStatus;
    };
    await ConnectionService.updateStatus(userId, targetLinkedinId, status);
    successResponse(res, null, "Connection status updated");
  } catch (error: any) {
    next(error);
  }
};

// POST /api/connections/reconcile — bulk-reconcile PENDING rows against a
// LinkedIn snapshot (sent-invitations + connections) sent by the extension
export const reconcileConnections = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const {
      stillPendingIds,
      connected,
      sentInvitationsFetched,
      sentListComplete,
      coverageFloor,
      actorLinkedinId,
    } = req.body as {
      stillPendingIds: string[];
      connected: {
        targetLinkedinId: string;
        name?: string;
        connectedAt?: string;
      }[];
      sentInvitationsFetched: boolean;
      sentListComplete?: boolean;
      coverageFloor?: string;
      actorLinkedinId?: string;
    };
    const counts = await ConnectionService.reconcile(userId, {
      stillPendingIds,
      connected,
      sentInvitationsFetched,
      // Absent means partial. An older extension that doesn't send this flag
      // must never be able to resolve rows to EXPIRED.
      sentListComplete: sentListComplete === true,
      coverageFloor,
      actorLinkedinId,
    });
    logger.info("[CT][api] POST /connections/reconcile", { userId, ...counts });
    successResponse(res, counts, "Connections reconciled");
  } catch (error: any) {
    next(error);
  }
};

// POST /api/connections/backfill-name — fill a missing target name on a row
export const backfillConnectionName = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { targetLinkedinId, targetName } = req.body as {
      targetLinkedinId: string;
      targetName: string;
    };
    await ConnectionService.backfillName(userId, targetLinkedinId, targetName);
    successResponse(res, null, "Name backfilled");
  } catch (error: any) {
    next(error);
  }
};

// GET /api/connections/stats — per-user + global connection-request metrics
export const getConnectionStats = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const stats = await ConnectionService.getUserAndGlobalStats(userId);
    successResponse(res, stats, "Connection stats retrieved");
  } catch (error: any) {
    next(error);
  }
};

const toDate = (v: unknown): Date | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
};

// GET /api/connections/stats/today — the extension popup's daily counters:
// Sent/Accepted/Withdrawn/Expired for the CALLER's local day only (from/to
// query params — computed client-side as local-midnight-to-now in UTC ISO,
// same pattern as the report dashboard's toUtcStartOfDayIso/toUtcEndOfDayIso).
// Reads the append-only connection_request_events log (not the current-state
// table), so it reflects every transition that happened today, not a
// point-in-time snapshot. Deliberately excludes Pending — "how many are
// outstanding right now" is a live/cumulative concept, not something that
// resets at midnight.
export const getConnectionStatsToday = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const now = new Date();
    const to = toDate(req.query.to) ?? now;
    const from = toDate(req.query.from) ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const stats = await ConnectionEventService.getTotals(from, to, { userId });
    successResponse(res, stats, "Today's connection stats retrieved");
  } catch (error: any) {
    next(error);
  }
};
