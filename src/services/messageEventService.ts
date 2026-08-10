// src/services/messageEventService.ts
import { MessageEventType } from "@prisma/client";
import { randomUUID } from "crypto";
import { MessageEventRepository, QualifyingEventRow } from "../repositories/messageEventRepository";

// UTC calendar day, matching the day-level granularity buildSeries/dedup key
// off — a message qualifies for at most one FRESH/REPLIED instance ever, but
// FOLLOW_UP can repeat, possibly more than once on the same day.
function truncDayUTC(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}

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
  // The message's own text — powers the Messages report's in-app chat popup.
  // Optional: older extension builds won't send it, and some captures
  // legitimately have none (e.g. an attachment-only message).
  text?: string;
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
          text: e.text?.trim() || null,
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

  /**
   * Same bucketing as getSeriesByOwner, additionally split by LinkedIn
   * account — one row per (date, userId, selfLinkedinId). Powers the chart
   * hover popup's per-account breakdown within an owner's segment.
   */
  static getSeriesByOwnerAccount(
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
      accountId: string | null;
      fresh: number;
      followups: number;
      sent: number;
      received: number;
      replied: number;
    }>
  > {
    if (ownerIds.length === 0) return Promise.resolve([]);
    return MessageEventRepository.getSeriesByOwnerAccount(from, to, ownerIds, opts);
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

  /**
   * Paginated supporting-table rows for the Messages report: one row per
   * (kind, conversation, calendar day), deduped to that day's MOST RECENT
   * qualifying instance — the exact same 3 kinds (FRESH/FOLLOW_UP/REPLIED)
   * and the exact same per-day-distinct counting getSeries buckets the chart
   * on, so a day's chart bar and that day's table row count always agree.
   * Replaces the old table (MessageActivityService.list), which listed one
   * row per conversation dated by its lastMessageAt — a conversation active
   * across several days contributed a bar to each of the chart's days but
   * only ever showed up in the table once.
   */
  static async list(params: {
    page: number;
    limit: number;
    userId?: string;
    userIds?: string[];
    selfLinkedinId?: string;
    selfLinkedinIds?: string[];
    kind?: "FRESH" | "FOLLOW_UP" | "REPLIED";
    from: Date;
    to: Date;
  }): Promise<{
    data: Array<{
      userId: string;
      conversationKey: string;
      occurredAt: Date;
      kind: "FRESH" | "FOLLOW_UP" | "REPLIED";
      participantName: string | null;
      participantProfileUrl: string | null;
      selfName: string | null;
    }>;
    metadata: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));

    const rows = await MessageEventRepository.findQualifyingEvents(params.from, params.to, {
      userId: params.userId,
      restrictUserIds: params.userIds,
      selfLinkedinId: params.selfLinkedinId,
      selfLinkedinIds: params.selfLinkedinIds,
    });

    // Dedupe to one row per (kind, conversation, day) — keep the latest.
    const byKey = new Map<string, QualifyingEventRow>();
    for (const r of rows) {
      const key = `${r.kind}::${r.userId}::${r.conversationKey}::${truncDayUTC(r.occurredAt)}`;
      const existing = byKey.get(key);
      if (!existing || r.occurredAt.getTime() > existing.occurredAt.getTime()) byKey.set(key, r);
    }
    const sorted = Array.from(byKey.values()).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    const rows_ = params.kind ? sorted.filter(r => r.kind === params.kind) : sorted;

    const total = rows_.length;
    const page_ = rows_.slice((page - 1) * limit, (page - 1) * limit + limit);

    const pairs = Array.from(new Map(page_.map(r => [`${r.userId}:${r.conversationKey}`, r])).values());
    const activities = await MessageEventRepository.findActivityIdentities(pairs);
    const byIdKey = new Map(activities.map(a => [`${a.userId}:${a.conversationKey}`, a]));

    const data = page_.map(r => {
      const activity = byIdKey.get(`${r.userId}:${r.conversationKey}`);
      return {
        userId: r.userId,
        conversationKey: r.conversationKey,
        occurredAt: r.occurredAt,
        kind: r.kind,
        participantName: activity?.participantName ?? null,
        participantProfileUrl: activity?.participantProfileUrl ?? null,
        selfName: activity?.selfName ?? null,
      };
    });

    return {
      data,
      metadata: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }
}
