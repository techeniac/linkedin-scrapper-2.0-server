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
    // `${bucket}` interpolates to a SEPARATE SQL parameter placeholder each
    // time it appears in the template, even though the JS value is identical
    // every time. Postgres's DISTINCT ON requires its leading ORDER BY
    // expressions to be the SAME parsed expression, and two different
    // placeholders don't count as the same expression — so `date_trunc`
    // must be computed exactly ONCE (here, in the `bucketed` CTE) and
    // referenced by its output column name (`bucket`) everywhere else.
    return prisma.$queryRaw`
      WITH bucketed AS (
        SELECT user_id, date_trunc(${bucket}, snapshot_date) AS bucket, snapshot_date, count
        FROM forgotten_lead_snapshots
        WHERE snapshot_date >= ${from} AND snapshot_date <= ${to}
          ${ownerFilter}
      ),
      latest_per_bucket AS (
        SELECT DISTINCT ON (user_id, bucket) user_id, bucket, count
        FROM bucketed
        ORDER BY user_id, bucket, snapshot_date DESC
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
    // Same single-interpolation-of-`${bucket}` fix as getSeries above — see
    // that method's comment for why a repeated `date_trunc(${bucket}, ...)`
    // breaks DISTINCT ON.
    return prisma.$queryRaw`
      WITH bucketed AS (
        SELECT user_id, date_trunc(${bucket}, snapshot_date) AS bucket, snapshot_date, count
        FROM forgotten_lead_snapshots
        WHERE snapshot_date >= ${from} AND snapshot_date <= ${to}
          AND user_id = ANY(${ownerIds})
      )
      SELECT DISTINCT ON (user_id, bucket)
        to_char(bucket, 'YYYY-MM-DD') AS date,
        user_id AS "userId",
        count
      FROM bucketed
      ORDER BY user_id, bucket, snapshot_date DESC
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
