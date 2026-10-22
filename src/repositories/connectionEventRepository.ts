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


// Connection events carry no owner of their own — user_id is just the browser
// session that scraped them. To credit a lead to the same owner the message
// reports use, link each event to its message conversation by
// (self LinkedIn account, participant) and read conversation_owner_cache:
//   - resolved owner  -> that owner replaces user_id (so an owner override
//                        applies here with no restamping),
//   - 'ambiguous'     -> excluded, same as every message report,
//   - no conversation -> falls back to the scraper (a request that never led
//                        to a message has nothing to resolve against).
// Names fall back to connection_requests, because INTERCEPT events are
// written before LinkedIn supplies the name and the event log is append-only.
// Everything below selects FROM ev, whose user_id is the EFFECTIVE owner, so
// the existing owner/actor/status filters and GROUP BYs apply unchanged.
// Index support: message_events (self_linkedin_id, participant_linkedin_id).
const EFFECTIVE_EVENTS = Prisma.sql`
  WITH ev AS (
    SELECT e.id,
           COALESCE(o.resolved_owner_id, e.user_id) AS user_id,
           e.target_linkedin_id,
           COALESCE(e.target_name, r.target_name) AS target_name,
           COALESCE(e.target_profile_url, r.target_profile_url) AS target_profile_url,
           e.actor_linkedin_id,
           e.actor_name,
           e.to_status,
           e.occurred_at
    FROM connection_request_events e
    LEFT JOIN connection_requests r
           ON r.user_id = e.user_id AND r.target_linkedin_id = e.target_linkedin_id
    LEFT JOIN LATERAL (
      SELECT c.resolved_owner_id, c.attribution_source
      FROM message_events m
      JOIN conversation_owner_cache c ON c.conversation_key = m.conversation_key
      WHERE m.self_linkedin_id = e.actor_linkedin_id
        AND m.participant_linkedin_id = e.target_linkedin_id
      ORDER BY m.occurred_at DESC
      LIMIT 1
    ) o ON true
    WHERE o.attribution_source IS DISTINCT FROM 'ambiguous'
  )`;

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
      ${EFFECTIVE_EVENTS}
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COUNT(DISTINCT target_linkedin_id) FILTER (WHERE to_status = 'PENDING')::int AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM ev
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
      ${EFFECTIVE_EVENTS}
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             user_id AS "userId",
             COUNT(DISTINCT target_linkedin_id) FILTER (WHERE to_status = 'PENDING')::int AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM ev
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
      ${EFFECTIVE_EVENTS}
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             user_id AS "userId",
             actor_linkedin_id AS "accountId",
             COUNT(DISTINCT target_linkedin_id) FILTER (WHERE to_status = 'PENDING')::int AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM ev
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND user_id = ANY(${ownerIds})
        ${actorFilter}
        ${statusFilter}
      GROUP BY 1, user_id, actor_linkedin_id
      ORDER BY 1
    `;
  }

  /**
   * Paginated event rows + total count — the Connection Requests report
   * table. Reads the same effective-owner view as the chart (EFFECTIVE_EVENTS),
   * so a row's owner, name and visibility always match the bars: one row per
   * (target, transition), dated by occurredAt. `orderBy` is a whitelisted
   * column key (see ConnectionEventService.SORT_COLUMNS), never raw input.
   */
  static async listEvents(p: {
    from: Date;
    to: Date;
    userId?: string;
    userIds?: string[];
    actorLinkedinId?: string;
    actorLinkedinIds?: string[];
    statuses?: ConnectionRequestStatus[];
    search?: string;
    orderBy: "occurred_at" | "to_status" | "target_name";
    sortOrder: "asc" | "desc";
    skip: number;
    take: number;
  }) {
    const owner = p.userId
      ? Prisma.sql`AND ev.user_id = ${p.userId}`
      : p.userIds
        ? Prisma.sql`AND ev.user_id = ANY(${p.userIds})`
        : Prisma.empty;
    const like = p.search ? `%${p.search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const search = like
      ? Prisma.sql`AND (ev.target_name ILIKE ${like} OR ev.actor_name ILIKE ${like} OR ev.target_profile_url ILIKE ${like})`
      : Prisma.empty;
    const where = Prisma.sql`
      WHERE ev.occurred_at >= ${p.from} AND ev.occurred_at <= ${p.to}
        ${owner}
        ${actorFilterSql(p)}
        ${statusFilterSql(p.statuses)}
        ${search}`;
    const order = Prisma.raw(`ev.${p.orderBy} ${p.sortOrder === "asc" ? "ASC" : "DESC"}`);

    const [data, count] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          id: string;
          userId: string;
          targetName: string | null;
          targetProfileUrl: string | null;
          targetLinkedinId: string;
          actorName: string | null;
          toStatus: ConnectionRequestStatus;
          occurredAt: Date;
          userName: string | null;
        }>
      >`
        ${EFFECTIVE_EVENTS}
        SELECT ev.id, ev.user_id AS "userId", ev.target_name AS "targetName",
               ev.target_profile_url AS "targetProfileUrl",
               ev.target_linkedin_id AS "targetLinkedinId", ev.actor_name AS "actorName",
               ev.to_status AS "toStatus", ev.occurred_at AS "occurredAt",
               u.name AS "userName"
        FROM ev
        LEFT JOIN users u ON u.id = ev.user_id
        ${where}
        ORDER BY ${order}, ev.id
        LIMIT ${p.take} OFFSET ${p.skip}
      `,
      prisma.$queryRaw<Array<{ count: number }>>`
        ${EFFECTIVE_EVENTS}
        SELECT COUNT(*)::int AS count FROM ev ${where}
      `,
    ]);
    return { data, total: count[0]?.count ?? 0 };
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
      ${EFFECTIVE_EVENTS}
      SELECT COUNT(DISTINCT target_linkedin_id) FILTER (WHERE to_status = 'PENDING')::int AS sent,
             COUNT(*) FILTER (WHERE to_status = 'ACCEPTED')::int  AS accepted,
             COUNT(*) FILTER (WHERE to_status = 'WITHDRAWN')::int AS withdrawn,
             COUNT(*) FILTER (WHERE to_status = 'EXPIRED')::int   AS expired
      FROM ev
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${actorFilter}
    `;
    const r = rows[0];
    return { sent: r?.sent ?? 0, accepted: r?.accepted ?? 0, withdrawn: r?.withdrawn ?? 0, expired: r?.expired ?? 0 };
  }
}
