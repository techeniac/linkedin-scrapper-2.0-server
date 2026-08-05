// src/services/connectionService.ts
import { ConnectionEventSource, ConnectionRequestStatus, Prisma } from "@prisma/client";
import { ConnectionRepository } from "../repositories/connectionRepository";
import { ConnectionEventService, estimateExpiryDate } from "./connectionEventService";

// Read params for the public, paginated connections list.
export interface ListConnectionsParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  search?: string;
  userId?: string;
  userIds?: string[]; // restrict to a set of owners (used when no single userId)
  actorLinkedinId?: string; // the logged-in LinkedIn account that sent the request
  actorLinkedinIds?: string[]; // multi-select account filter; takes precedence over actorLinkedinId
  statuses?: ConnectionRequestStatus[]; // multi-select Status filter
  sentFrom?: Date;
  sentTo?: Date;
}

/**
 * LinkedIn connection-request tracking.
 *
 * One row per request a user sends (unique per user+target). LinkedIn's Sent
 * list contains ONLY outstanding invitations and labels every one "Pending";
 * resolved ones simply vanish. So the statuses are derived by elimination:
 *   - PENDING   : present in LinkedIn's Sent list
 *   - ACCEPTED  : absent, and the target is now a 1st-degree connection
 *   - WITHDRAWN : absent, and we intercepted the user retracting it
 *   - EXPIRED   : absent, and neither of the above
 *
 * EXPIRED therefore also absorbs declines: LinkedIn never notifies a sender
 * that an invitation was rejected, and the API that does distinguish REJECTED
 * from EXPIRED is partner-gated. Both simply disappear, identically.
 *
 * NOT_ACCEPTED is deprecated and never written; it survives only so legacy rows
 * and historical events stay readable.
 *
 * This table is the CURRENT-STATE projection and is deliberately lossy — a
 * re-send re-opens the row and overwrites its previous outcome. Historical
 * counts must come from ConnectionRequestEvent (see connectionEventService).
 *
 * All Prisma access lives in ConnectionRepository — this service holds only
 * the business decisions (reconcile's accept/expire rules, which columns are
 * sortable, how to build the search/date filter for list()).
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
  withdrawn: number;
  expired: number;
  /** DEPRECATED: superseded by `expired`. Always 0 for new data. */
  notAccepted: number;
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
  // False when the sent-invitations fetch failed — then we NEVER resolve a row
  // to EXPIRED (can't distinguish resolved from still-pending).
  sentInvitationsFetched: boolean;
  // True only when the walk of LinkedIn's Sent list reached the end (an empty
  // page) rather than stopping at a page cap or a parse failure. A PARTIAL walk
  // looks exactly like "everything disappeared", so it must never resolve
  // anything — treat a missing flag as partial.
  sentListComplete?: boolean;
  // Oldest connectedAt in the fetched connections page; null when the whole
  // connections list was fetched (full coverage). Rows sent before this floor
  // aren't marked EXPIRED (a possible acceptance is outside our window).
  coverageFloor?: string | null;
  // The LinkedIn account performing the sync; scopes resolution to rows sent
  // from this actor (or with an unknown actor) to avoid cross-account errors.
  actorLinkedinId?: string | null;
}

export interface ReconcileResult {
  accepted: number;
  expired: number;
  /** Absent for the first time — awaiting a second confirming walk. */
  newlyAbsent: number;
  /** Were absent, showed up again — absence marker cleared, no harm done. */
  reappeared: number;
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

    // Delegated so the row update and its history event are written together.
    // A re-send overwrites this row's previous outcome, but the event for that
    // outcome was already recorded — which is what keeps expiry counts honest.
    await ConnectionEventService.recordSent({
      userId,
      targetLinkedinId,
      toStatus: ConnectionRequestStatus.PENDING,
      source: ConnectionEventSource.INTERCEPT,
      targetProfileUrl,
      targetName,
      actorLinkedinId,
      actorName,
      actorPublicIdentifier,
    });
  }

  /**
   * Resolve a request that is still PENDING to a terminal status
   * (ACCEPTED / WITHDRAWN / EXPIRED). Guarded to PENDING rows so an out-of-order
   * signal can never overwrite an already-resolved request — a late "accepted"
   * won't undo a "withdrawn". No-op when there is nothing pending for that
   * target, and in that case no event is emitted either (no transition happened).
   */
  static async updateStatus(
    userId: string,
    targetLinkedinId: string,
    status: ConnectionRequestStatus,
  ): Promise<void> {
    // PENDING is the starting state, not a resolution target.
    if (!isTerminal(status)) return;

    // Withdrawals come from intercepting the user's own click, so the moment is
    // observed exactly — no estimate flag.
    await ConnectionEventService.applyTransition(
      {
        userId,
        targetLinkedinId,
        toStatus: status,
        source: ConnectionEventSource.INTERCEPT,
        occurredAt: new Date(),
      },
      [ConnectionRequestStatus.PENDING],
    );
  }

  /**
   * Bulk-reconcile the user's PENDING requests against a LinkedIn snapshot.
   *
   * Rules (every write is guarded to status PENDING, so already-resolved rows
   * are never touched):
   *   - target now a connection            -> ACCEPTED, dated with LinkedIn's
   *                                            real connection date
   *   - gone from the Sent list, not a
   *     connection, walk COMPLETE, within
   *     the connections coverage           -> absence recorded; EXPIRED only on
   *                                            the SECOND consecutive such walk
   *   - was absent, now present again      -> absence marker cleared
   *   - otherwise                          -> left PENDING (no write)
   *
   * Two safety properties matter here:
   *
   * 1. ACCEPTED runs first and excludes connected ids from the expiry pass, so
   *    an acceptance can never be mistaken for an expiry.
   * 2. Expiry requires a COMPLETE walk AND two consecutive confirmations.
   *    Offset pagination over a list that mutates mid-walk can skip an entry,
   *    and a skipped entry is indistinguishable from a resolved one — observed
   *    live, where a 1-month-old invitation surfaced among 6-month-old ones on
   *    the final page. One skip must not expire a live invitation.
   *
   * Optionally actor-scoped so syncing from account X can't resolve rows sent
   * from account Y.
   */
  static async reconcile(
    userId: string,
    input: ReconcileInput,
  ): Promise<ReconcileResult> {
    const {
      stillPendingIds,
      connected,
      sentInvitationsFetched,
      sentListComplete,
      coverageFloor,
      actorLinkedinId,
    } = input;

    // Actor scope: match this actor OR rows whose actor is unknown (null).
    const actorScope = actorLinkedinId
      ? { OR: [{ actorLinkedinId }, { actorLinkedinId: null }] }
      : {};

    // All candidate rows currently pending for this user (+ actor scope).
    const candidates = await ConnectionRepository.findPendingByUser(userId, actorScope);

    const connectedMap = new Map(
      connected.map((c) => [c.targetLinkedinId, c]),
    );
    const stillPendingSet = new Set(stillPendingIds);
    const floor = toDate(coverageFloor);

    const now = new Date();

    // ── ACCEPTED ────────────────────────────────────────────────────────────
    // Runs first so acceptance always wins over expiry. occurredAt is the real
    // LinkedIn connection date, so a chart shows when people actually accepted
    // rather than when a sync happened to notice.
    let accepted = 0;
    for (const r of candidates.filter((c) =>
      connectedMap.has(c.targetLinkedinId),
    )) {
      const conn = connectedMap.get(r.targetLinkedinId)!;
      const connectedAt = toDate(conn.connectedAt);
      const applied = await ConnectionEventService.applyTransition(
        {
          userId,
          targetLinkedinId: r.targetLinkedinId,
          toStatus: ConnectionRequestStatus.ACCEPTED,
          source: ConnectionEventSource.RECONCILE,
          occurredAt: connectedAt ?? now,
          occurredAtIsEstimate: connectedAt === null,
          // Backfill the name only when we don't already have one.
          targetName: r.targetName == null ? (conn.name ?? null) : null,
          actorLinkedinId,
        },
        [ConnectionRequestStatus.PENDING],
      );
      if (applied) accepted++;
    }

    // ── EXPIRED (absorbs declines — LinkedIn exposes no reject signal) ──────
    // Requires a COMPLETE walk of the Sent list. A partial walk is
    // indistinguishable from "everything vanished", so resolving from one would
    // wrongly expire the entire pending set.
    let expired = 0;
    let newlyAbsent = 0;
    let reappeared = 0;

    if (sentInvitationsFetched && sentListComplete === true) {
      const absentNow = candidates.filter(
        (r) =>
          !connectedMap.has(r.targetLinkedinId) &&
          !stillPendingSet.has(r.targetLinkedinId) &&
          // Outside the connections snapshot's coverage a late acceptance may
          // simply not be visible yet — don't call those expired.
          (floor === null || r.sentAt >= floor),
      );

      for (const r of absentNow) {
        if (r.absentSince) {
          // Second consecutive complete walk with this row missing. Offset
          // pagination over a mutating list can skip an entry once; being
          // skipped twice in a row is vanishingly unlikely, so now we resolve.
          const applied = await ConnectionEventService.applyTransition(
            {
              userId,
              targetLinkedinId: r.targetLinkedinId,
              toStatus: ConnectionRequestStatus.EXPIRED,
              source: ConnectionEventSource.RECONCILE,
              // LinkedIn never reports the expiry moment; this is always
              // inferred — see estimateExpiryDate.
              occurredAt: estimateExpiryDate(r.sentAt, now),
              occurredAtIsEstimate: true,
              actorLinkedinId,
            },
            [ConnectionRequestStatus.PENDING],
          );
          if (applied) expired++;
        } else {
          await ConnectionRepository.markAbsent(userId, r.targetLinkedinId, now);
          newlyAbsent++;
        }
      }

      // Marked absent before but present again now — a skipped page, not a
      // resolution. Clear the marker so it isn't expired on the next walk.
      const backIds = candidates
        .filter(
          (r) => r.absentSince && stillPendingSet.has(r.targetLinkedinId),
        )
        .map((r) => r.targetLinkedinId);
      if (backIds.length) {
        const res = await ConnectionRepository.clearAbsent(userId, backIds);
        reappeared = res.count;
      }
    }

    return {
      accepted,
      expired,
      newlyAbsent,
      reappeared,
      stillPending: candidates.length - accepted - expired,
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
    await ConnectionRepository.backfillName(userId, targetLinkedinId, targetName);
  }

  /**
   * Aggregate counts. Scope:
   *   - `userId` set        → that single user
   *   - `restrictUserIds`   → only those users (e.g. HubSpot-connected owners)
   *   - neither             → global (all users)
   */
  static async getStats(
    userId?: string,
    restrictUserIds?: string[],
  ): Promise<ConnectionStats> {
    const where: Prisma.ConnectionRequestWhereInput = userId
      ? { userId }
      : restrictUserIds
        ? { userId: { in: restrictUserIds } }
        : {};

    const grouped = await ConnectionRepository.groupByStatus(where);

    const stats: ConnectionStats = {
      sent: 0,
      pending: 0,
      accepted: 0,
      withdrawn: 0,
      expired: 0,
      notAccepted: 0,
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
        case ConnectionRequestStatus.WITHDRAWN:
          stats.withdrawn = count;
          break;
        case ConnectionRequestStatus.EXPIRED:
          stats.expired = count;
          break;
        case ConnectionRequestStatus.NOT_ACCEPTED:
          // Legacy rows only — never written any more. Surfaced under `expired`
          // too so a historical row isn't silently dropped from the total.
          stats.notAccepted = count;
          stats.expired += count;
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

  // Columns a client is allowed to sort by (guards against arbitrary orderBy).
  private static readonly SORT_COLUMNS = new Set([
    "sentAt",
    "resolvedAt",
    "status",
    "targetName",
    "createdAt",
  ]);

  /** Paginated / filtered / sorted list of connection rows (public read). */
  static async list(p: ListConnectionsParams): Promise<{
    data: unknown[];
    metadata: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = Math.max(1, p.page || 1);
    const limit = Math.min(100, Math.max(1, p.limit || 10));
    const sortBy = this.SORT_COLUMNS.has(p.sortBy ?? "") ? (p.sortBy as string) : "sentAt";
    const sortOrder: "asc" | "desc" = p.sortOrder === "asc" ? "asc" : "desc";

    const where: Prisma.ConnectionRequestWhereInput = {};
    if (p.userId) where.userId = p.userId;
    else if (p.userIds) where.userId = { in: p.userIds };
    if (p.actorLinkedinIds?.length) where.actorLinkedinId = { in: p.actorLinkedinIds };
    else if (p.actorLinkedinId) where.actorLinkedinId = p.actorLinkedinId;
    if (p.statuses?.length) where.status = { in: p.statuses };
    if (p.sentFrom || p.sentTo) {
      where.sentAt = {};
      if (p.sentFrom) where.sentAt.gte = p.sentFrom;
      if (p.sentTo) where.sentAt.lte = p.sentTo;
    }
    if (p.search) {
      where.OR = [
        { targetName: { contains: p.search, mode: "insensitive" } },
        { actorName: { contains: p.search, mode: "insensitive" } },
        { targetProfileUrl: { contains: p.search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await ConnectionRepository.findAndCount(
      where,
      { [sortBy]: sortOrder } as Prisma.ConnectionRequestOrderByWithRelationInput,
      (page - 1) * limit,
      limit,
    );

    return {
      data,
      metadata: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /**
   * COHORT view: of the requests SENT in each bucket, how many are now in each
   * status. Bucketed on sent_at over the current-state table.
   *
   * Note this is inherently lossy for history — the current-state table holds
   * one row per contact and a re-send moves that row's sent_at forward, so an
   * earlier send silently leaves its original bucket. For "how much activity
   * happened in this period", use ConnectionEventService.getSeries instead,
   * which reads the append-only event log and survives re-sends.
   */
  static getSeries(
    userId: string | undefined,
    from: Date,
    to: Date,
    restrictUserIds?: string[],
    actorLinkedinId?: string,
    granularity: "day" | "week" | "month" = "day",
  ): Promise<
    Array<{
      date: string;
      sent: number;
      accepted: number;
      pending: number;
      expired: number;
      /** DEPRECATED alias of `expired`, kept so existing chart code keeps working. */
      ignored: number;
      withdrawn: number;
    }>
  > {
    return ConnectionRepository.getCohortSeries(from, to, { userId, restrictUserIds, actorLinkedinId }, granularity);
  }
}
