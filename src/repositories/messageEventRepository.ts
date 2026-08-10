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
  text: string | null;
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

export interface QualifyingEventRow {
  userId: string;
  conversationKey: string;
  occurredAt: Date;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
  kind: "FRESH" | "FOLLOW_UP" | "REPLIED";
}

export interface ActivityIdentity {
  userId: string;
  conversationKey: string;
  participantName: string | null;
  participantProfileUrl: string | null;
  selfName: string | null;
}

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
            self_time_zone, participant_linkedin_id, self_linkedin_id, text, created_at
          ) VALUES (
            ${r.id}, ${r.userId}, ${r.conversationKey}, ${r.messageId},
            ${r.type}::"MessageEventType", ${r.occurredAt},
            ${r.isFirstTouch}, ${r.isFollowUp}, ${r.isFirstReply}, ${r.respondsToAt},
            ${r.selfTimeZone}, ${r.participantLinkedinId}, ${r.selfLinkedinId}, ${r.text}, NOW()
          )
          ON CONFLICT (user_id, conversation_key, message_id) DO UPDATE SET
            is_first_touch = message_events.is_first_touch AND EXCLUDED.is_first_touch,
            is_first_reply = message_events.is_first_reply AND EXCLUDED.is_first_reply,
            is_follow_up   = message_events.is_follow_up   OR  EXCLUDED.is_follow_up,
            responds_to_at = GREATEST(message_events.responds_to_at, EXCLUDED.responds_to_at),
            self_time_zone = COALESCE(EXCLUDED.self_time_zone, message_events.self_time_zone),
            participant_linkedin_id = COALESCE(EXCLUDED.participant_linkedin_id, message_events.participant_linkedin_id),
            self_linkedin_id        = COALESCE(EXCLUDED.self_linkedin_id, message_events.self_linkedin_id),
            text                    = COALESCE(EXCLUDED.text, message_events.text)
            -- occurred_at and type are immutable facts about the message and
            -- are deliberately excluded from this UPDATE.
        `,
      ),
    );
  }

  /**
   * Per-bucket counts over the event history — see MessageEventService.getSeries.
   * Counts DISTINCT conversations (people), not raw message events: 3 replies
   * from the same person in one day count once, not 3 times — matches how the
   * report reads "5 people replied today," not "15 reply messages arrived."
   */
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
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
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
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND user_id = ANY(${ownerIds})
        ${accountFilter}
      GROUP BY 1, user_id
      ORDER BY 1
    `;
  }

  /**
   * Same as getSeriesByOwner, additionally split by LinkedIn account (self)
   * — one row per (date, userId, selfLinkedinId). Powers the chart hover
   * popup's per-account breakdown within an owner's segment. `accountId` is
   * `null` for events captured before self-account tracking existed —
   * grouped as their own bucket rather than dropped, same as the
   * connections-side equivalent.
   */
  static getSeriesByOwnerAccount(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: Pick<SeriesFilterOpts, "selfLinkedinId" | "selfLinkedinIds"> & { granularity?: "day" | "week" | "month" } = {},
  ): Promise<
    Array<{
      date: string;
      userId: string;
      accountId: string | null;
      fresh: number;
      followups: number;
      sent: number;
      received: number;
      replied: number;
    }>
  > {
    const bucket = bucketOf(opts.granularity);
    const accountFilter = accountFilterSql(opts);

    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, occurred_at), 'YYYY-MM-DD') AS date,
             user_id AS "userId",
             self_linkedin_id AS "accountId",
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
      FROM message_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
        AND user_id = ANY(${ownerIds})
        ${accountFilter}
      GROUP BY 1, user_id, self_linkedin_id
      ORDER BY 1
    `;
  }

  /**
   * Totals over the event history for a window — see MessageEventService.getTotals.
   * Same distinct-conversation counting as getSeries above.
   */
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
      SELECT COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_first_touch)::int  AS fresh,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT' AND is_follow_up)::int   AS followups,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'SENT')::int                   AS sent,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED')::int               AS received,
             COUNT(DISTINCT conversation_key) FILTER (WHERE type = 'RECEIVED' AND is_first_reply)::int AS replied
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

  /**
   * Every raw event that qualifies as FRESH (SENT, is_first_touch), FOLLOW_UP
   * (SENT, is_follow_up), or REPLIED (RECEIVED, is_first_reply) — the exact
   * same 3 boolean flags the chart's `fresh`/`followups`/`replied` series
   * count as DISTINCT conversations per day (see getSeries above). The
   * Messages report table (MessageEventService.list) dedupes these the same
   * way, so every table row always has a matching chart bar.
   */
  static async findQualifyingEvents(from: Date, to: Date, opts: SeriesFilterOpts): Promise<QualifyingEventRow[]> {
    const ownerFilter = ownerFilterSql(opts);
    const accountFilter = accountFilterSql(opts);

    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        conversation_key: string;
        occurred_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
        kind: "FRESH" | "FOLLOW_UP" | "REPLIED";
      }>
    >`
      SELECT user_id, conversation_key, occurred_at,
             participant_linkedin_id, self_linkedin_id,
             CASE
               WHEN type = 'SENT' AND is_first_touch THEN 'FRESH'
               WHEN type = 'SENT' AND is_follow_up THEN 'FOLLOW_UP'
               ELSE 'REPLIED'
             END AS kind
      FROM message_events
      WHERE (
        (type = 'SENT' AND is_first_touch)
        OR (type = 'SENT' AND is_follow_up)
        OR (type = 'RECEIVED' AND is_first_reply)
      )
      AND occurred_at >= ${from} AND occurred_at <= ${to}
      ${ownerFilter}
      ${accountFilter}
    `;

    return rows.map(r => ({
      userId: r.user_id,
      conversationKey: r.conversation_key,
      occurredAt: r.occurred_at,
      participantLinkedinId: r.participant_linkedin_id,
      selfLinkedinId: r.self_linkedin_id,
      kind: r.kind,
    }));
  }

  /**
   * Batch-resolves participant/self display identity for a page of
   * (userId, conversationKey) pairs — MessageEvent only stores ids, not
   * names/urls; MessageActivity is the only place those are stored. Same
   * lookup LateMessageRepository.findActivityIdentities does; kept here too
   * since MessageActivity is the shared identity table, not late-message-
   * specific.
   */
  static findActivityIdentities(pairs: Array<{ userId: string; conversationKey: string }>): Promise<ActivityIdentity[]> {
    if (pairs.length === 0) return Promise.resolve([]);
    return prisma.messageActivity.findMany({
      where: { OR: pairs.map(r => ({ userId: r.userId, conversationKey: r.conversationKey })) },
      select: { userId: true, conversationKey: true, participantName: true, participantProfileUrl: true, selfName: true },
    });
  }

}
