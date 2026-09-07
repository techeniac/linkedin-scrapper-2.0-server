// src/repositories/nextStepGapRepository.ts
//
// Data-access layer for next_step_gap_snapshots. Owns every Prisma/raw-SQL
// touch point; NextStepGapService owns the business decisions. Mirrors
// forgottenLeadRepository.ts's shape exactly — see that file's comment for
// the GAUGE-not-event-count reasoning this also follows — except every
// aggregate here is TWO columns (touchedCount, neverTouchedCount) instead of
// one, since the report tracks both segments.
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

export class NextStepGapRepository {
  static async upsertSnapshot(
    userId: string,
    snapshotDate: Date,
    touchedCount: number,
    neverTouchedCount: number,
  ): Promise<void> {
    await prisma.nextStepGapSnapshot.upsert({
      where: { userId_snapshotDate: { userId, snapshotDate } },
      update: { touchedCount, neverTouchedCount },
      create: { userId, snapshotDate, touchedCount, neverTouchedCount },
    });
  }

  static async hasSnapshotToday(userId: string, todayUtcMidnight: Date): Promise<boolean> {
    const row = await prisma.nextStepGapSnapshot.findUnique({
      where: { userId_snapshotDate: { userId, snapshotDate: todayUtcMidnight } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Per-bucket (touched, neverTouched) counts, summed across whichever
   * owners are in scope. Same last-snapshot-per-bucket-per-owner rule as
   * ForgottenLeadRepository.getSeries — see that method's comment.
   */
  static getSeries(
    from: Date,
    to: Date,
    opts: FilterOpts & { granularity?: "day" | "week" | "month" } = {},
  ): Promise<Array<{ date: string; touched: number; neverTouched: number }>> {
    const bucket = bucketOf(opts.granularity);
    const ownerFilter = ownerFilterSql(opts);
    // See ForgottenLeadRepository.getSeries's comment: `${bucket}` must be
    // interpolated exactly once (here, in the `bucketed` CTE) and referenced
    // by column name everywhere else, or DISTINCT ON breaks.
    return prisma.$queryRaw`
      WITH bucketed AS (
        SELECT user_id, date_trunc(${bucket}, snapshot_date) AS bucket, snapshot_date,
               touched_count, never_touched_count
        FROM next_step_gap_snapshots
        WHERE snapshot_date >= ${from} AND snapshot_date <= ${to}
          ${ownerFilter}
      ),
      latest_per_bucket AS (
        SELECT DISTINCT ON (user_id, bucket) user_id, bucket, touched_count, never_touched_count
        FROM bucketed
        ORDER BY user_id, bucket, snapshot_date DESC
      )
      SELECT to_char(bucket, 'YYYY-MM-DD') AS date,
             SUM(touched_count)::int AS touched,
             SUM(never_touched_count)::int AS "neverTouched"
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
  ): Promise<Array<{ date: string; userId: string; touched: number; neverTouched: number }>> {
    if (!ownerIds.length) return Promise.resolve([]);
    const bucket = bucketOf(opts.granularity);
    return prisma.$queryRaw`
      WITH bucketed AS (
        SELECT user_id, date_trunc(${bucket}, snapshot_date) AS bucket, snapshot_date,
               touched_count, never_touched_count
        FROM next_step_gap_snapshots
        WHERE snapshot_date >= ${from} AND snapshot_date <= ${to}
          AND user_id = ANY(${ownerIds})
      )
      SELECT DISTINCT ON (user_id, bucket)
        to_char(bucket, 'YYYY-MM-DD') AS date,
        user_id AS "userId",
        touched_count AS touched,
        never_touched_count AS "neverTouched"
      FROM bucketed
      ORDER BY user_id, bucket, snapshot_date DESC
    `;
  }

  /** Sum of each in-scope owner's MOST RECENT snapshot ever recorded — the "right now" KPI, per segment. */
  static async getLatestTotals(ownerIds: string[]): Promise<{ touched: number; neverTouched: number }> {
    if (!ownerIds.length) return { touched: 0, neverTouched: 0 };
    const rows = await prisma.$queryRaw<Array<{ touched: number; neverTouched: number }>>`
      SELECT DISTINCT ON (user_id) touched_count AS touched, never_touched_count AS "neverTouched"
      FROM next_step_gap_snapshots
      WHERE user_id = ANY(${ownerIds})
      ORDER BY user_id, snapshot_date DESC
    `;
    return rows.reduce(
      (sum, r) => ({ touched: sum.touched + r.touched, neverTouched: sum.neverTouched + r.neverTouched }),
      { touched: 0, neverTouched: 0 },
    );
  }
}
