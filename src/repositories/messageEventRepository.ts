// src/repositories/messageEventRepository.ts
//
// Data-access layer for message_events. MessageEventService owns the
// business decisions (parsing/validating incoming event rows, the merge
// semantics documented on recordEvents); this file owns every Prisma/raw-SQL
// touch point.
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";

export interface MessageEventRow {
  id: string;
  userId: string;
  conversationKey: string;
  messageId: string;
  type: string;
  occurredAt: Date;
  isFirstTouch: boolean;
  isFollowUp: boolean;
  isFirstReply: boolean;
  respondsToAt: Date | null;
  selfTimeZone: string | null;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
}

type SeriesFilterOpts = {
  userId?: string;
  restrictUserIds?: string[];
  selfLinkedinId?: string;
  selfLinkedinIds?: string[];
};

const bucketOf = (granularity?: "day" | "week" | "month") =>
  granularity === "week" ? "week" : granularity === "month" ? "month" : "day";

const ownerFilterSql = (opts: Pick<SeriesFilterOpts, "userId" | "restrictUserIds">) =>
  opts.userId
    ? Prisma.sql`AND user_id = ${opts.userId}`
    : opts.restrictUserIds
      ? Prisma.sql`AND user_id = ANY(${opts.restrictUserIds})`
      : Prisma.empty;

const accountFilterSql = (opts: Pick<SeriesFilterOpts, "selfLinkedinId" | "selfLinkedinIds">) =>
  opts.selfLinkedinIds?.length
    ? Prisma.sql`AND self_linkedin_id = ANY(${opts.selfLinkedinIds})`
    : opts.selfLinkedinId
      ? Prisma.sql`AND self_linkedin_id = ${opts.selfLinkedinId}`
      : Prisma.empty;

export class MessageEventRepository {
  /**
   * Upserts a batch of already-validated event rows, one statement per row in
   * a single transaction — see MessageEventService.recordEvents for why each
   * field's merge rule (AND / OR / GREATEST / COALESCE) is safe regardless of
   * which derivation saw more or less history.
   */
  static upsertEvents(rows: MessageEventRow[]) {
    return prisma.$transaction(
      rows.map(
        r => prisma.$executeRaw`
          INSERT INTO message_events (
            id, user_id, conversation_key, message_id, type, occurred_at,
            is_first_touch, is_follow_up, is_first_reply, responds_to_at,
            self_time_zone, participant_linkedin_id, self_linkedin_id, created_at
          ) VALUES (
            ${r.id}, ${r.userId}, ${r.conversationKey}, ${r.messageId},
            ${r.type}::"MessageEventType", ${r.occurredAt},
            ${r.isFirstTouch}, ${r.isFollowUp}, ${r.isFirstReply}, ${r.respondsToAt},
            ${r.selfTimeZone}, ${r.participantLinkedinId}, ${r.selfLinkedinId}, NOW()
          )
          ON CONFLICT (user_id, conversation_key, message_id) DO UPDATE SET
            is_first_touch = message_events.is_first_touch AND EXCLUDED.is_first_touch,
            is_first_reply = message_events.is_first_reply AND EXCLUDED.is_first_reply,
            is_follow_up   = message_events.is_follow_up   OR  EXCLUDED.is_follow_up,
            responds_to_at = GREATEST(message_events.responds_to_at, EXCLUDED.responds_to_at),
            self_time_zone = COALESCE(EXCLUDED.self_time_zone, message_events.self_time_zone),
            participant_linkedin_id = COALESCE(EXCLUDED.participant_linkedin_id, message_events.participant_linkedin_id),
            self_linkedin_id        = COALESCE(EXCLUDED.self_linkedin_id, message_events.self_linkedin_id)
            -- occurred_at and type are immutable facts about the message and
            -- are deliberately excluded from this UPDATE.
        `,
      ),
    );
  }

  /** Per-bucket counts over the event history — see MessageEventService.getSeries. */
  static getSeries(
    from: Date,
    to: Date,
    opts: SeriesFilterOpts & { granularity?: "day" | "week" | "month" } = {},
  ): Promise<Array<{ date: string; fresh: number; followups: number; sent: number; received: number; replied: number }>> {
    const bucket = bucketOf(opts.granularity);
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             COUNT(*) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(*) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(*) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(*) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(*) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
      GROUP BY 1
      ORDER BY 1
    `;
  }

  /** Same as getSeries, additionally grouped by owner — see MessageEventService.getSeriesByOwner. */
  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: Pick<SeriesFilterOpts, "selfLinkedinId" | "selfLinkedinIds"> & { granularity?: "day" | "week" | "month" } = {},
  ): Promise<Array<{ date: string; userId: string; fresh: number; followups: number; sent: number; received: number; replied: number }>> {
    const bucket = bucketOf(opts.granularity);
    const accountFilter = accountFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             user_id AS "userId",
             COUNT(*) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(*) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(*) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(*) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(*) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND user_id = ANY(${ownerIds})
        ${accountFilter}
      GROUP BY 1, user_id
      ORDER BY 1
    `;
  }

  /** Totals over the event history for a window — see MessageEventService.getTotals. */
  static async getTotals(
    from: Date,
    to: Date,
    opts: SeriesFilterOpts = {},
  ): Promise<{ fresh: number; followups: number; sent: number; received: number; replied: number }> {
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);

    const rows = await prisma.$queryRaw<
      Array<{ fresh: number; followups: number; sent: number; received: number; replied: number }>
    >`
      SELECT COUNT(*) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(*) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(*) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(*) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(*) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
    `;
    const r = rows[0];
    return {
      fresh: r?.fresh ?? 0,
      followups: r?.followups ?? 0,
      sent: r?.sent ?? 0,
      received: r?.received ?? 0,
      replied: r?.replied ?? 0,
    };
  }
}
