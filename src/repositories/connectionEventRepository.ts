// src/repositories/connectionEventRepository.ts
//
// Data-access layer for connection_requests / connection_request_events.
// Owns every Prisma/raw-SQL touch point; ConnectionEventService owns the
// business decisions (which prior statuses are valid, when a transition
// counts as "the same status", how a bucket/date-range maps to a report
// series) and calls these primitives to carry them out.
import { ConnectionRequestStatus, Prisma } from "@prisma/client";
import prisma from "../config/prisma";

// Shared by applyTransition/recordSent — see ConnectionEventService's
// applyTransition doc comment for why these are widened from Prisma's
// defaults (2s connection-wait / 5s run): a transaction that deliberately
// waits on a row lock needs more room than one that never expects to block.
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 10_000 };

export interface LockedRequestRow {
  id: string;
  status: ConnectionRequestStatus;
  targetName: string | null;
  targetProfileUrl: string | null;
  actorLinkedinId: string | null;
  actorName: string | null;
  actorPublicIdentifier: string | null;
}

type SeriesFilterOpts = {
  userId?: string;
  restrictUserIds?: string[];
  actorLinkedinId?: string;
  actorLinkedinIds?: string[];
};

const bucketOf = (granularity?: "day" | "week" | "month") =>
  granularity === "week" ? "week" : granularity === "month" ? "month" : "day";

const ownerFilterSql = (opts: Pick<SeriesFilterOpts, "userId" | "restrictUserIds">) =>
  opts.userId
    ? Prisma.sql`AND user_id = ${opts.userId}`
    : opts.restrictUserIds
      ? Prisma.sql`AND user_id = ANY(${opts.restrictUserIds})`
      : Prisma.empty;

const actorFilterSql = (opts: Pick<SeriesFilterOpts, "actorLinkedinId" | "actorLinkedinIds">) =>
  opts.actorLinkedinIds?.length
    ? Prisma.sql`AND actor_linkedin_id = ANY(${opts.actorLinkedinIds})`
    : opts.actorLinkedinId
      ? Prisma.sql`AND actor_linkedin_id = ${opts.actorLinkedinId}`
      : Prisma.empty;

// Narrows the chart to a set of statuses' activity (e.g. the Connections
// report's multi-select Status filter) — matches the same `to_status` the 4
// COUNT FILTER columns already key off, so selecting a subset just zeroes the
// others out rather than needing a different query shape.
const statusFilterSql = (statuses?: ConnectionRequestStatus[]) =>
  statuses?.length ? Prisma.sql`AND to_status = ANY(${statuses}::"ConnectionRequestStatus"[])` : Prisma.empty;

export class ConnectionEventRepository {
  /** Runs `fn` in a transaction sized for the row-lock waits applyTransition/recordSent expect. */
  static transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(fn, TRANSACTION_OPTIONS);
  }

  /**
   * Locks (SELECT ... FOR UPDATE) the current-state row for (userId,
   * targetLinkedinId), if any. MUST be called inside a `transaction()`
   * callback — the lock is only meaningful for the transaction's lifetime.
   */
  static async lockRequestRow(
    tx: Prisma.TransactionClient,
    userId: string,
    targetLinkedinId: string,
  ): Promise<LockedRequestRow | undefined> {
    const rows = await tx.$queryRaw<LockedRequestRow[]>`
      SELECT id, status,
             target_name AS "targetName",
             target_profile_url AS "targetProfileUrl",
             actor_linkedin_id AS "actorLinkedinId",
             actor_name AS "actorName",
             actor_public_identifier AS "actorPublicIdentifier"
      FROM connection_requests
      WHERE user_id = ${userId} AND target_linkedin_id = ${targetLinkedinId}
      FOR UPDATE
    `;
    return rows[0];
  }

  static updateRequest(tx: Prisma.TransactionClient, id: string, data: Prisma.ConnectionRequestUncheckedUpdateInput) {
    return tx.connectionRequest.update({ where: { id }, data });
  }

  static createRequest(tx: Prisma.TransactionClient, data: Prisma.ConnectionRequestUncheckedCreateInput) {
    return tx.connectionRequest.create({ data });
  }

  static insertEvent(tx: Prisma.TransactionClient, data: Prisma.ConnectionRequestEventUncheckedCreateInput) {
    return tx.connectionRequestEvent.create({ data });
  }

  /** Per-bucket counts over the event history — see ConnectionEventService.getSeries. */
  static getSeries(
    from: Date,
    to: Date,
    opts: SeriesFilterOpts & { granularity?: "day" | "week" | "month"; statuses?: ConnectionRequestStatus[] } = {},
  ): Promise<Array<{ date: string; sent: number; accepted: number; withdrawn: number; expired: number }>> {
    const bucket = bucketOf(opts.granularity);
    const ownerFilter = ownerFilterSql(opts);
    const actorFilter = actorFilterSql(opts);
    const statusFilter = statusFilterSql(opts.statuses);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COUNT(DISTINCT target_linkedin_id) FILTER (WHERE to_status = 'PENDING')::int AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM connection_request_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${actorFilter}
        ${statusFilter}
      GROUP BY 1
      ORDER BY 1
    `;
  }

  /** Same as getSeries, additionally grouped by owner — see ConnectionEventService.getSeriesByOwner. */
  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: Pick<SeriesFilterOpts, "actorLinkedinId" | "actorLinkedinIds"> & {
      granularity?: "day" | "week" | "month";
      statuses?: ConnectionRequestStatus[];
    } = {},
  ): Promise<Array<{ date: string; userId: string; sent: number; accepted: number; withdrawn: number; expired: number }>> {
    const bucket = bucketOf(opts.granularity);
    const actorFilter = actorFilterSql(opts);
    const statusFilter = statusFilterSql(opts.statuses);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             user_id AS "userId",
             COUNT(DISTINCT target_linkedin_id) FILTER (WHERE to_status = 'PENDING')::int AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM connection_request_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND user_id = ANY(${ownerIds})
        ${actorFilter}
        ${statusFilter}
      GROUP BY 1, user_id
      ORDER BY 1
    `;
  }

  /**
   * Same as getSeriesByOwner, additionally split by LinkedIn account (actor)
   * — one row per (date, userId, actorLinkedinId). Powers the chart hover
   * popup's per-account breakdown within an owner's segment. `accountId` is
   * `null` for pre-actor-tracking events (grouped together as their own
   * bucket, same as any other GROUP BY column) — the frontend labels that
   * bucket "Unknown account" rather than silently dropping it, so the
   * per-account rows always sum back to the owner's segment total.
   */
  static getSeriesByOwnerAccount(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: SeriesFilterOpts & { granularity?: "day" | "week" | "month"; statuses?: ConnectionRequestStatus[] } = {},
  ): Promise<
    Array<{ date: string; userId: string; accountId: string | null; sent: number; accepted: number; withdrawn: number; expired: number }>
  > {
    const bucket = bucketOf(opts.granularity);
    const actorFilter = actorFilterSql(opts);
    const statusFilter = statusFilterSql(opts.statuses);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             user_id AS "userId",
             actor_linkedin_id AS "accountId",
             COUNT(DISTINCT target_linkedin_id) FILTER (WHERE to_status = 'PENDING')::int AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM connection_request_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND user_id = ANY(${ownerIds})
        ${actorFilter}
        ${statusFilter}
      GROUP BY 1, user_id, actor_linkedin_id
      ORDER BY 1
    `;
  }

  /**
   * Paginated event rows + total count, in one round trip — the Connection
   * Requests report table. Mirrors ConnectionRepository.findAndCount's shape
   * (same `user: { select: { name: true } }` owner-name fallback), but reads
   * the append-only event log instead of the current-state table: one row
   * per (target, transition), dated by occurredAt — see
   * ConnectionEventService.list for why.
   */
  static findAndCountEvents(
    where: Prisma.ConnectionRequestEventWhereInput,
    orderBy: Prisma.ConnectionRequestEventOrderByWithRelationInput,
    skip: number,
    take: number,
  ) {
    return prisma.$transaction([
      prisma.connectionRequestEvent.findMany({
        where,
        orderBy,
        skip,
        take,
        select: {
          id: true,
          userId: true, // so the controller can map the owner to its HubSpot name
          targetName: true,
          targetProfileUrl: true,
          targetLinkedinId: true,
          actorName: true,
          toStatus: true,
          occurredAt: true,
          user: { select: { name: true } }, // DB-name fallback
        },
      }),
      prisma.connectionRequestEvent.count({ where }),
    ]);
  }

  /** Totals over the event history for a window — see ConnectionEventService.getTotals. */
  static async getTotals(
    from: Date,
    to: Date,
    opts: SeriesFilterOpts = {},
  ): Promise<{ sent: number; accepted: number; withdrawn: number; expired: number }> {
    const ownerFilter = ownerFilterSql(opts);
    const actorFilter = actorFilterSql(opts);

    const rows = await prisma.$queryRaw<Array<{ sent: number; accepted: number; withdrawn: number; expired: number }>>`
      SELECT COUNT(DISTINCT target_linkedin_id) FILTER (WHERE to_status = 'PENDING')::int AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM connection_request_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${actorFilter}
    `;
    const r = rows[0];
    return { sent: r?.sent ?? 0, accepted: r?.accepted ?? 0, withdrawn: r?.withdrawn ?? 0, expired: r?.expired ?? 0 };
  }
}
