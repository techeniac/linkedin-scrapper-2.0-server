// src/repositories/scheduledNoTouchRepository.ts
//
// Data-access layer for scheduled_no_touch_snapshots. Byte-for-byte the same
// shape as forgottenLeadRepository.ts (single-count gauge, no segmentation)
// — see that file's comments for the full GAUGE-not-event-count reasoning.
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

export class ScheduledNoTouchRepository {
  static async upsertSnapshot(userId: string, snapshotDate: Date, count: number): Promise<void> {
    await prisma.scheduledNoTouchSnapshot.upsert({
      where: { userId_snapshotDate: { userId, snapshotDate } },
      update: { count },
      create: { userId, snapshotDate, count },
    });
  }

  static async hasSnapshotToday(userId: string, todayUtcMidnight: Date): Promise<boolean> {
    const row = await prisma.scheduledNoTouchSnapshot.findUnique({
      where: { userId_snapshotDate: { userId, snapshotDate: todayUtcMidnight } },
      select: { id: true },
    });
    return row !== null;
  }

  static getSeries(
    from: Date,
    to: Date,
    opts: FilterOpts & { granularity?: "day" | "week" | "month" } = {},
  ): Promise<Array<{ date: string; count: number }>> {
    const bucket = bucketOf(opts.granularity);
    const ownerFilter = ownerFilterSql(opts);
    return prisma.$queryRaw`
      WITH bucketed AS (
        SELECT user_id, date_trunc(${bucket}, snapshot_date) AS bucket, snapshot_date, count
        FROM scheduled_no_touch_snapshots
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

  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: { granularity?: "day" | "week" | "month" } = {},
  ): Promise<Array<{ date: string; userId: string; count: number }>> {
    if (!ownerIds.length) return Promise.resolve([]);
    const bucket = bucketOf(opts.granularity);
    return prisma.$queryRaw`
      WITH bucketed AS (
        SELECT user_id, date_trunc(${bucket}, snapshot_date) AS bucket, snapshot_date, count
        FROM scheduled_no_touch_snapshots
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

  static async getLatestTotal(ownerIds: string[]): Promise<number> {
    if (!ownerIds.length) return 0;
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT DISTINCT ON (user_id) count
      FROM scheduled_no_touch_snapshots
      WHERE user_id = ANY(${ownerIds})
      ORDER BY user_id, snapshot_date DESC
    `;
    return rows.reduce((sum, r) => sum + r.count, 0);
  }
}
