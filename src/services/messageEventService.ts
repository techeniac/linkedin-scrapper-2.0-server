// src/services/messageEventService.ts
import { Prisma, MessageEventType } from "@prisma/client";
import prisma from "../config/prisma";

/**
 * Append-only per-message history — see the MessageEvent model comment in
 * schema.prisma for why this exists (MessageActivity's lastMessageAt bucketing
 * misattributes a conversation's whole lifetime to a single day).
 *
 * The extension derives these flags client-side, in deriveActivity, which
 * walks the conversation's full ordered message list once per record — the
 * natural place to compute "is this the first message we ever sent here" or
 * "did this immediately follow our own prior send". The backend only inserts
 * them, idempotently.
 */

export interface MessageEventInput {
  messageId: string;
  type: MessageEventType;
  occurredAt: string; // ISO or epoch-ms string
  isFirstTouch?: boolean;
  isFollowUp?: boolean;
  isFirstReply?: boolean;
  respondsToAt?: string; // ISO or epoch-ms string; absent for the first message
  selfTimeZone?: string; // IANA zone, e.g. "Asia/Kolkata"
}

export interface RecordEventsInput {
  conversationKey: string;
  participantLinkedinId?: string | null;
  selfLinkedinId?: string | null;
  events: MessageEventInput[];
}

const toDate = (v: string): Date | null => {
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

export class MessageEventService {
  /**
   * Insert this batch's events, skipping any already recorded (same
   * conversation re-derived on every page load — most of the batch is usually
   * a repeat). Never updates: a delivered message's facts don't change.
   */
  static async recordEvents(
    userId: string,
    input: RecordEventsInput,
  ): Promise<void> {
    if (!input.events.length) return;

    const rows = input.events
      .map((e) => {
        const occurredAt = toDate(e.occurredAt);
        if (!occurredAt) return null;
        return {
          userId,
          conversationKey: input.conversationKey,
          messageId: e.messageId,
          type: e.type,
          occurredAt,
          isFirstTouch: !!e.isFirstTouch,
          isFollowUp: !!e.isFollowUp,
          isFirstReply: !!e.isFirstReply,
          respondsToAt: e.respondsToAt ? toDate(e.respondsToAt) : null,
          selfTimeZone: e.selfTimeZone ?? null,
          participantLinkedinId: input.participantLinkedinId ?? null,
          selfLinkedinId: input.selfLinkedinId ?? null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (!rows.length) return;

    await prisma.messageEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }

  /**
   * Per-bucket counts over the EVENT history, bucketed on when each message
   * actually happened — this is what the Messaging Activity report's chart
   * reads instead of MessageActivityService.getSeries.
   */
  static async getSeries(
    from: Date,
    to: Date,
    opts: {
      userId?: string;
      restrictUserIds?: string[];
      selfLinkedinId?: string;
      granularity?: "day" | "week" | "month";
    } = {},
  ): Promise<
    Array<{
      date: string;
      fresh: number;
      followups: number;
      sent: number;
      received: number;
      replied: number;
    }>
  > {
    const { userId, restrictUserIds, selfLinkedinId } = opts;
    const bucket =
      opts.granularity === "week"
        ? "week"
        : opts.granularity === "month"
          ? "month"
          : "day";

    const ownerFilter = userId
      ? Prisma.sql`AND user_id = ${userId}`
      : restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${restrictUserIds})`
        : Prisma.empty;
    const accountFilter = selfLinkedinId
      ? Prisma.sql`AND self_linkedin_id = ${selfLinkedinId}`
      : Prisma.empty;

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

  /** Totals over the event history for a window (no bucketing). */
  static async getTotals(
    from: Date,
    to: Date,
    opts: {
      userId?: string;
      restrictUserIds?: string[];
      selfLinkedinId?: string;
    } = {},
  ): Promise<{
    fresh: number;
    followups: number;
    sent: number;
    received: number;
    replied: number;
  }> {
    const { userId, restrictUserIds, selfLinkedinId } = opts;
    const ownerFilter = userId
      ? Prisma.sql`AND user_id = ${userId}`
      : restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${restrictUserIds})`
        : Prisma.empty;
    const accountFilter = selfLinkedinId
      ? Prisma.sql`AND self_linkedin_id = ${selfLinkedinId}`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<
      Array<{
        fresh: number;
        followups: number;
        sent: number;
        received: number;
        replied: number;
      }>
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
