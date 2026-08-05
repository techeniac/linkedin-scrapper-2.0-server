// src/repositories/connectionRepository.ts
//
// Data-access layer for the connection_requests CURRENT-STATE table.
// ConnectionService owns the business decisions (reconcile's accept/expire
// rules, which columns are sortable, how to build a search/date filter);
// this file owns every Prisma/raw-SQL touch point for that table.
import { ConnectionRequestStatus, Prisma } from "@prisma/client";
import prisma from "../config/prisma";

export interface PendingCandidate {
  targetLinkedinId: string;
  targetName: string | null;
  targetProfileUrl: string | null;
  sentAt: Date;
  absentSince: Date | null;
}

type CohortSeriesOpts = {
  userId?: string;
  restrictUserIds?: string[];
  actorLinkedinId?: string;
};

export class ConnectionRepository {
  /** Every currently-PENDING row for a user, optionally actor-scoped — the reconcile() candidate set. */
  static findPendingByUser(userId: string, actorScope: Prisma.ConnectionRequestWhereInput): Promise<PendingCandidate[]> {
    return prisma.connectionRequest.findMany({
      where: { userId, status: ConnectionRequestStatus.PENDING, ...actorScope },
      select: { targetLinkedinId: true, targetName: true, targetProfileUrl: true, sentAt: true, absentSince: true },
    });
  }

  /** Marks a still-PENDING row as newly absent from a completed Sent-list walk. */
  static markAbsent(userId: string, targetLinkedinId: string, absentSince: Date) {
    return prisma.connectionRequest.updateMany({
      where: { userId, targetLinkedinId, status: ConnectionRequestStatus.PENDING },
      data: { absentSince },
    });
  }

  /** Clears the absence marker for rows that reappeared in a later walk. */
  static clearAbsent(userId: string, targetLinkedinIds: string[]) {
    return prisma.connectionRequest.updateMany({
      where: { userId, status: ConnectionRequestStatus.PENDING, targetLinkedinId: { in: targetLinkedinIds } },
      data: { absentSince: null },
    });
  }

  /** Fills in the target's display name only where it's currently unknown. */
  static backfillName(userId: string, targetLinkedinId: string, targetName: string) {
    return prisma.connectionRequest.updateMany({
      where: { userId, targetLinkedinId, targetName: null },
      data: { targetName },
    });
  }

  /** Row counts grouped by status, for ConnectionService.getStats. */
  static groupByStatus(where: Prisma.ConnectionRequestWhereInput) {
    return prisma.connectionRequest.groupBy({ by: ["status"], _count: { _all: true }, where });
  }

  /** Paginated rows + total count, in one round trip. */
  static findAndCount(
    where: Prisma.ConnectionRequestWhereInput,
    orderBy: Prisma.ConnectionRequestOrderByWithRelationInput,
    skip: number,
    take: number,
  ) {
    return prisma.$transaction([
      prisma.connectionRequest.findMany({
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
          status: true,
          sentAt: true,
          resolvedAt: true,
          user: { select: { name: true } }, // DB-name fallback
        },
      }),
      prisma.connectionRequest.count({ where }),
    ]);
  }

  /**
   * COHORT view: of the requests SENT in each bucket, how many are now in
   * each status. Bucketed on sent_at over the current-state table — see
   * ConnectionService.getSeries for why this differs from the event-log view.
   */
  static getCohortSeries(
    from: Date,
    to: Date,
    opts: CohortSeriesOpts,
    granularity: "day" | "week" | "month" = "day",
  ): Promise<
    Array<{ date: string; sent: number; accepted: number; pending: number; expired: number; ignored: number; withdrawn: number }>
  > {
    const { userId, restrictUserIds, actorLinkedinId } = opts;
    const ownerFilter = userId
      ? Prisma.sql`AND user_id = ${userId}`
      : restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${restrictUserIds})`
        : Prisma.empty;
    const accountFilter = actorLinkedinId ? Prisma.sql`AND actor_linkedin_id = ${actorLinkedinId}` : Prisma.empty;
    const bucket = granularity === "week" ? "week" : granularity === "month" ? "month" : "day";

    // `date` is the bucket-start (Mon for week, 1st for month) as YYYY-MM-DD.
    // `expired` counts EXPIRED plus any legacy NOT_ACCEPTED rows, so historical
    // data isn't silently dropped from the chart after the rename.
    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, sent_at), 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS sent,
             COUNT(*) FILTER (WHERE status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
             COUNT(*) FILTER (WHERE status IN ('EXPIRED', 'NOT_ACCEPTED'))::int AS expired,
             COUNT(*) FILTER (WHERE status IN ('EXPIRED', 'NOT_ACCEPTED'))::int AS ignored,
             COUNT(*) FILTER (WHERE status = 'WITHDRAWN')::int AS withdrawn
      FROM connection_requests
      WHERE sent_at >= ${from} AND sent_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
      GROUP BY 1
      ORDER BY 1
    `;
  }
}
