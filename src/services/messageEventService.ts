// src/services/messageEventService.ts
import { MessageEventType } from "@prisma/client";
import { randomUUID } from "crypto";
import { MessageEventRepository } from "../repositories/messageEventRepository";

/**
 * Per-message history — see the MessageEvent model comment in schema.prisma
 * for why this exists (MessageActivity's lastMessageAt bucketing misattributes
 * a conversation's whole lifetime to a single day).
 *
 * The extension derives these flags client-side, in deriveActivity, which
 * walks whatever messages are CURRENTLY LOADED for a conversation. LinkedIn
 * paginates — a long thread's full history is not loaded on first open, more
 * arrives as the user scrolls back — so an early derivation can genuinely be
 * wrong about a boundary message: with only the newest slice loaded, the
 * earliest-visible self-message looks like "the first thing I ever sent"
 * (isFirstTouch=true, respondsToAt=null) when in truth it responds to
 * something further back that simply hadn't loaded yet.
 *
 * VERIFIED live against a real conversation (2026-08): a message loaded on
 * its own (2 total messages visible) was recorded isFirstTouch=true,
 * isFollowUp=false, respondsToAt=null. Once the same conversation's fuller
 * history loaded (7 messages, going back 3 months further), the SAME message
 * correctly derived as isFirstTouch=false, isFollowUp=true,
 * respondsToAt=<the actual prior message>. Same for isFirstReply on the reply
 * that followed it.
 *
 * recordEvents therefore UPSERTS rather than pure-inserts, so a later, more-
 * informed derivation can correct an earlier, partial one. Each field's merge
 * rule is chosen so a REGRESSION is impossible even if a later call happens to
 * see LESS history than a previous one (a fresh page session's first batch
 * size varies — we observed 2 one time, 20 another, for the same account):
 *
 *   isFirstTouch / isFirstReply : AND  — more history can only reveal an
 *     earlier message and so DEMOTE a false "this is the first X"; it can
 *     never manufacture a new one. Once any derivation says false, it must
 *     stay false forever.
 *   isFollowUp                  : OR   — the mirror case: more history can
 *     only PROMOTE a message to "this is a follow-up" by revealing the self-
 *     message it re-pings; once any derivation says true, it stays true.
 *   respondsToAt                : GREATEST — the true value is the closest
 *     preceding message's time. More history can only reveal a CLOSER
 *     predecessor (a later timestamp, still before this message), never a
 *     more distant one. Postgres GREATEST ignores NULLs, so "no predecessor
 *     known yet" correctly loses to any real value.
 *   selfTimeZone / participantLinkedinId / selfLinkedinId : COALESCE(new, old)
 *     — plain identity/context fields, never wipe a known value with a
 *     missing one.
 *   occurredAt / type            : immutable facts about the message itself
 *     (when it was delivered, who sent it) — never part of the UPDATE.
 *
 * All Prisma/raw-SQL access lives in MessageEventRepository — this service
 * holds only the business decisions (parsing/validating incoming rows, which
 * report series to shape).
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
   * Record this batch's events. New messageIds are inserted as-is; a
   * messageId already on file has its derived-classification fields MERGED
   * with the new derivation rather than overwritten — see the class-level
   * comment for why each field's merge rule is safe in both directions
   * (a more-informed OR a less-informed later call).
   *
   * One conversation's batch is rarely more than a few hundred messages, so a
   * per-row statement inside a single transaction is simple and fast enough;
   * this isn't a path that needs bulk multi-row SQL.
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
          id: randomUUID(),
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

    await MessageEventRepository.upsertEvents(rows);
  }

  /**
   * Per-bucket counts over the EVENT history, bucketed on when each message
   * actually happened — this is what the Messaging Activity report's chart
   * reads instead of MessageActivityService.getSeries.
   */
  static getSeries(
    from: Date,
    to: Date,
    opts: {
      userId?: string;
      restrictUserIds?: string[];
      selfLinkedinId?: string;
      selfLinkedinIds?: string[]; // multi-select account filter; takes precedence over selfLinkedinId
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
    return MessageEventRepository.getSeries(from, to, opts);
  }

  /**
   * Same bucketing as getSeries, but ALSO grouped by owner — one row per
   * (date, userId). Powers the report chart's per-Sales-Person stacked
   * segments when more than one owner is selected.
   */
  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: {
      selfLinkedinId?: string;
      selfLinkedinIds?: string[];
      granularity?: "day" | "week" | "month";
    } = {},
  ): Promise<
    Array<{
      date: string;
      userId: string;
      fresh: number;
      followups: number;
      sent: number;
      received: number;
      replied: number;
    }>
  > {
    if (ownerIds.length === 0) return Promise.resolve([]);
    return MessageEventRepository.getSeriesByOwner(from, to, ownerIds, opts);
  }

  /** Totals over the event history for a window (no bucketing). */
  static getTotals(
    from: Date,
    to: Date,
    opts: {
      userId?: string;
      restrictUserIds?: string[];
      selfLinkedinId?: string;
      selfLinkedinIds?: string[];
    } = {},
  ): Promise<{
    fresh: number;
    followups: number;
    sent: number;
    received: number;
    replied: number;
  }> {
    return MessageEventRepository.getTotals(from, to, opts);
  }
}
