// src/services/connectionService.ts
import { ConnectionRequestStatus } from "@prisma/client";
import prisma from "../config/prisma";

/**
 * LinkedIn connection-request tracking.
 *
 * We record one row per request a user sends (unique per user+target). LinkedIn
 * only reliably surfaces "sent" and "pending"; the other states are derived:
 *   - ACCEPTED     : the target later resolves to a 1st-degree connection
 *   - WITHDRAWN    : the user retracts the invite
 *   - NOT_ACCEPTED : declined / ignored / expired (set by reconciliation)
 *
 * "Sent" is therefore the total row count; the four statuses partition it.
 */

export interface TrackSentInput {
  targetLinkedinId: string;
  targetProfileUrl?: string | null;
  targetName?: string | null;
  // The LinkedIn account (actor B) logged into the browser that sent the request.
  actorLinkedinId?: string | null;
  actorName?: string | null;
  actorPublicIdentifier?: string | null;
}

export interface ConnectionStats {
  sent: number;
  pending: number;
  accepted: number;
  notAccepted: number;
  withdrawn: number;
}

// Payload from the extension's connections snapshot (LinkedIn sent-invitations +
// connections lists), used to reconcile PENDING rows in bulk.
export interface ReconcileInput {
  // Member ids ("ACoAA…") still present in the user's LinkedIn "Sent" list.
  stillPendingIds: string[];
  // 1st-degree connections seen in the (recently-added) connections snapshot.
  connected: {
    targetLinkedinId: string;
    name?: string | null;
    connectedAt?: string | null; // ISO or epoch-ms string
  }[];
  // False when the sent-invitations fetch failed — then we NEVER mark
  // NOT_ACCEPTED (can't distinguish resolved-not-accepted from still-pending).
  sentInvitationsFetched: boolean;
  // Oldest connectedAt in the fetched connections page; null when the whole
  // connections list was fetched (full coverage). Rows sent before this floor
  // aren't marked NOT_ACCEPTED (a possible acceptance is outside our window).
  coverageFloor?: string | null;
  // The LinkedIn account performing the sync; scopes NOT_ACCEPTED to rows sent
  // from this actor (or with an unknown actor) to avoid cross-account errors.
  actorLinkedinId?: string | null;
}

export interface ReconcileResult {
  accepted: number;
  notAccepted: number;
  stillPending: number;
}

// Terminal statuses carry a resolvedAt timestamp; PENDING does not.
const isTerminal = (s: ConnectionRequestStatus) =>
  s !== ConnectionRequestStatus.PENDING;

// Parse an ISO string or epoch-ms string into a Date; null on empty/invalid.
const toDate = (v?: string | null): Date | null => {
  if (!v) return null;
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

export class ConnectionService {
  /**
   * Record a sent connection request. Idempotent per (user, target): a repeat
   * send updates the stored profile info and re-opens the request to PENDING
   * unless it is already ACCEPTED (you cannot re-invite an existing connection).
   */
  static async trackSent(
    userId: string,
    input: TrackSentInput,
  ): Promise<void> {
    const {
      targetLinkedinId,
      targetProfileUrl,
      targetName,
      actorLinkedinId,
      actorName,
      actorPublicIdentifier,
    } = input;

    const existing = await prisma.connectionRequest.findUnique({
      where: {
        userId_targetLinkedinId: { userId, targetLinkedinId },
      },
      select: { id: true, status: true },
    });

    if (!existing) {
      await prisma.connectionRequest.create({
        data: {
          userId,
          targetLinkedinId,
          targetProfileUrl: targetProfileUrl ?? null,
          targetName: targetName ?? null,
          actorLinkedinId: actorLinkedinId ?? null,
          actorName: actorName ?? null,
          actorPublicIdentifier: actorPublicIdentifier ?? null,
          status: ConnectionRequestStatus.PENDING,
        },
      });
      return;
    }

    // Don't clobber an already-accepted connection. For any other prior state
    // (withdrawn / not-accepted / still pending) a new send re-opens it. Actor
    // details are refreshed to the account that sent this latest request.
    const reopen = existing.status !== ConnectionRequestStatus.ACCEPTED;
    await prisma.connectionRequest.update({
      where: { id: existing.id },
      data: {
        ...(targetProfileUrl != null && { targetProfileUrl }),
        ...(targetName != null && { targetName }),
        ...(actorLinkedinId != null && { actorLinkedinId }),
        ...(actorName != null && { actorName }),
        ...(actorPublicIdentifier != null && { actorPublicIdentifier }),
        ...(reopen && {
          status: ConnectionRequestStatus.PENDING,
          sentAt: new Date(),
          resolvedAt: null,
        }),
      },
    });
  }

  /**
   * Resolve a request that is still PENDING to a terminal status
   * (ACCEPTED / WITHDRAWN / NOT_ACCEPTED). Scoped to PENDING rows via updateMany
   * so an out-of-order reconcile can never overwrite an already-resolved request
   * (e.g. a late "accepted" signal won't undo a "withdrawn"). No-op when there
   * is nothing pending for that target.
   */
  static async updateStatus(
    userId: string,
    targetLinkedinId: string,
    status: ConnectionRequestStatus,
  ): Promise<void> {
    // PENDING is the starting state, not a resolution target.
    if (!isTerminal(status)) return;

    await prisma.connectionRequest.updateMany({
      where: {
        userId,
        targetLinkedinId,
        status: ConnectionRequestStatus.PENDING,
      },
      data: {
        status,
        resolvedAt: new Date(),
      },
    });
  }

  /**
   * Bulk-reconcile the user's PENDING requests against a LinkedIn snapshot.
   *
   * Rules (every write is scoped to status: PENDING, so ACCEPTED / WITHDRAWN /
   * NOT_ACCEPTED rows are never touched):
   *   - target now a connection            -> ACCEPTED (resolvedAt = connectedAt,
   *                                            backfill targetName if missing)
   *   - target gone from "Sent" list, not
   *     a connection, sent-invites fetched,
   *     and within the fetched coverage     -> NOT_ACCEPTED
   *   - otherwise                           -> left PENDING (no write)
   *
   * ACCEPTED wins over NOT_ACCEPTED (runs first; not-accepted excludes connected
   * ids). Optionally actor-scoped so syncing from account X can't resolve rows
   * sent from account Y.
   */
  static async reconcile(
    userId: string,
    input: ReconcileInput,
  ): Promise<ReconcileResult> {
    const {
      stillPendingIds,
      connected,
      sentInvitationsFetched,
      coverageFloor,
      actorLinkedinId,
    } = input;

    // Actor scope: match this actor OR rows whose actor is unknown (null).
    const actorScope = actorLinkedinId
      ? { OR: [{ actorLinkedinId }, { actorLinkedinId: null }] }
      : {};

    // All candidate rows currently pending for this user (+ actor scope).
    const candidates = await prisma.connectionRequest.findMany({
      where: {
        userId,
        status: ConnectionRequestStatus.PENDING,
        ...actorScope,
      },
      select: { targetLinkedinId: true, targetName: true, sentAt: true },
    });

    const connectedMap = new Map(
      connected.map((c) => [c.targetLinkedinId, c]),
    );
    const stillPendingSet = new Set(stillPendingIds);
    const floor = toDate(coverageFloor);

    // Build the two buckets from the loaded candidates.
    const acceptedRows = candidates.filter((r) =>
      connectedMap.has(r.targetLinkedinId),
    );
    const notAcceptedIds = candidates
      .filter(
        (r) =>
          !connectedMap.has(r.targetLinkedinId) &&
          !stillPendingSet.has(r.targetLinkedinId) &&
          sentInvitationsFetched &&
          (floor === null || r.sentAt >= floor),
      )
      .map((r) => r.targetLinkedinId);

    // ACCEPTED: per-row (needs per-target resolvedAt + name backfill), one txn.
    const acceptedUpdates = acceptedRows.map((r) => {
      const conn = connectedMap.get(r.targetLinkedinId)!;
      return prisma.connectionRequest.updateMany({
        where: {
          userId,
          targetLinkedinId: r.targetLinkedinId,
          status: ConnectionRequestStatus.PENDING,
        },
        data: {
          status: ConnectionRequestStatus.ACCEPTED,
          resolvedAt: toDate(conn.connectedAt) ?? new Date(),
          ...(r.targetName == null && conn.name && { targetName: conn.name }),
        },
      });
    });
    const acceptedResults = acceptedUpdates.length
      ? await prisma.$transaction(acceptedUpdates)
      : [];
    const accepted = acceptedResults.reduce((sum, r) => sum + r.count, 0);

    // NOT_ACCEPTED: one bulk update over the gated id list.
    let notAccepted = 0;
    if (notAcceptedIds.length) {
      const res = await prisma.connectionRequest.updateMany({
        where: {
          userId,
          status: ConnectionRequestStatus.PENDING,
          targetLinkedinId: { in: notAcceptedIds },
        },
        data: {
          status: ConnectionRequestStatus.NOT_ACCEPTED,
          resolvedAt: new Date(),
        },
      });
      notAccepted = res.count;
    }

    return {
      accepted,
      notAccepted,
      stillPending: candidates.length - accepted - notAccepted,
    };
  }

  /**
   * Backfill the target's display name on an existing row, only where it's
   * currently missing. Never creates a row and never overwrites a known name —
   * so it's safe to call from a post-connect enrichment event.
   */
  static async backfillName(
    userId: string,
    targetLinkedinId: string,
    targetName: string,
  ): Promise<void> {
    await prisma.connectionRequest.updateMany({
      where: { userId, targetLinkedinId, targetName: null },
      data: { targetName },
    });
  }

  /** Aggregate counts for one user, or globally when userId is omitted. */
  static async getStats(userId?: string): Promise<ConnectionStats> {
    const grouped = await prisma.connectionRequest.groupBy({
      by: ["status"],
      _count: { _all: true },
      ...(userId && { where: { userId } }),
    });

    const stats: ConnectionStats = {
      sent: 0,
      pending: 0,
      accepted: 0,
      notAccepted: 0,
      withdrawn: 0,
    };

    for (const row of grouped) {
      const count = row._count._all;
      stats.sent += count;
      switch (row.status) {
        case ConnectionRequestStatus.PENDING:
          stats.pending = count;
          break;
        case ConnectionRequestStatus.ACCEPTED:
          stats.accepted = count;
          break;
        case ConnectionRequestStatus.NOT_ACCEPTED:
          stats.notAccepted = count;
          break;
        case ConnectionRequestStatus.WITHDRAWN:
          stats.withdrawn = count;
          break;
      }
    }

    return stats;
  }

  /** Convenience: both the authenticated user's stats and the global totals. */
  static async getUserAndGlobalStats(
    userId: string,
  ): Promise<{ user: ConnectionStats; global: ConnectionStats }> {
    const [user, global] = await Promise.all([
      this.getStats(userId),
      this.getStats(),
    ]);
    return { user, global };
  }
}
