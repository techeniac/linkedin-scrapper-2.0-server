// src/services/lateMessageService.ts
import prisma from "../config/prisma";
import { Prisma } from "@prisma/client";
import { resolveTimeZone, convertLocalTimeToUTC } from "./hubspotHelpers";
import {
  LATE_MSG_THRESHOLD_HOURS,
  LATE_MSG_QUIET_START_HOUR,
  LATE_MSG_QUIET_END_HOUR,
  LATE_MSG_EDGE_MODE,
  LATE_FOLLOWUP_THRESHOLD_DAYS,
} from "../config/env";

/**
 * Late Messages report: was a SENT message a reply/follow-up sent later than
 * the expected deadline for whatever it was responding to?
 *
 * Two separate "late" categories, distinguished by what the message responded
 * to (derived from MessageEvent.isFollowUp, already computed by the extension)
 * — each with its OWN deadline rule, because "reply to an active conversation"
 * and "re-ping a cold prospect" have completely different realistic cadences:
 *
 *   - LATE_REPLY: responded to the OTHER party's message (a real reply).
 *     Deadline = computeReplyDeadline() — LATE_MSG_THRESHOLD_HOURS (default 3)
 *     hours from the message being replied to, adjusted for quiet hours
 *     [LATE_MSG_QUIET_START_HOUR, LATE_MSG_QUIET_END_HOUR) — by default
 *     00:00-07:00 — in the REP's own local time (MessageEvent.selfTimeZone,
 *     browser-sourced, same as the app's existing userTimeZone pattern). A
 *     message that arrives during quiet hours gets its clock started at
 *     quiet-hours-end instead: deadline = quietEnd + threshold. If a
 *     threshold computed from a message OUTSIDE quiet hours would spill into
 *     the next quiet-hours window, LATE_MSG_EDGE_MODE decides:
 *       CAP_AT_QUIET_START (default): deadline is capped at the moment quiet
 *         hours begin (must reply before midnight).
 *       EXTEND_PAST_QUIET: deadline extends to quietEnd + threshold, same as
 *         the "arrived during quiet hours" case.
 *     Assumes a non-wrapping quiet window (start hour < end hour) — true for
 *     the default 0-7 and any other same-day window; a window that wraps past
 *     midnight on the OTHER end (e.g. 22-6) is not handled.
 *
 *   - LATE_FOLLOW_UP: responded to our OWN prior send with no reply in
 *     between (a re-ping / cadence nudge). Deadline = computeFollowUpDeadline()
 *     — a flat LATE_FOLLOW_UP_THRESHOLD_DAYS (default 7) days, NO quiet-hours
 *     adjustment (immaterial at a multi-day scale). Also the deadline rule the
 *     Missed Follow-Up report (missedFollowUpService.ts) uses to decide
 *     whether a conversation's last SENT message is overdue.
 *
 * Both thresholds are env-var configurable so they can change without a
 * redeploy of the extension — the extension only reports facts (timestamps,
 * timezone, which message responded to which), this service holds the
 * judgment call.
 *
 * QUERY STRATEGY: LATE_REPLY needs the quiet-hours math above, which isn't
 * reasonably expressible as a single SQL predicate, so those candidates are
 * fetched and classified in JS. LATE_FOLLOW_UP has no such need — its
 * deadline is a flat day-offset — so it is filtered ENTIRELY IN SQL
 * (queryLateFollowUps below): only genuinely-late rows are ever transferred,
 * rather than fetching every SENT-with-a-response row and discarding most of
 * it in Node.
 */

// Thresholds validated and centralized in config/env.ts, alongside every
// other env-driven setting in this codebase.
const THRESHOLD_HOURS = LATE_MSG_THRESHOLD_HOURS;
const QUIET_START_HOUR = LATE_MSG_QUIET_START_HOUR;
const QUIET_END_HOUR = LATE_MSG_QUIET_END_HOUR;
const EDGE_MODE = LATE_MSG_EDGE_MODE;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function localDateAndHour(date: Date, timeZone: string): { dateStr: string; hour: number } {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "00";
  const hour = hourStr === "24" ? 0 : Number(hourStr);
  return { dateStr, hour };
}

// A real UTC instant for HH:00 local time on the given tz calendar date.
function localHourToUtc(dateStr: string, hour: number, timeZone: string): Date {
  const hh = String(hour).padStart(2, "0");
  return new Date(convertLocalTimeToUTC(dateStr, `${hh}:00`, timeZone));
}

const isInQuietHours = (hour: number): boolean =>
  hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;

/** The deadline by which a REPLY to `respondsToAt` is due, or it's late. */
export function computeReplyDeadline(respondsToAt: Date, timeZone?: string | null): Date {
  const tz = resolveTimeZone(timeZone ?? undefined);
  const { dateStr, hour } = localDateAndHour(respondsToAt, tz);

  if (isInQuietHours(hour)) {
    const quietEndUtc = localHourToUtc(dateStr, QUIET_END_HOUR, tz);
    return new Date(quietEndUtc.getTime() + THRESHOLD_HOURS * HOUR_MS);
  }

  const naiveDeadline = new Date(respondsToAt.getTime() + THRESHOLD_HOURS * HOUR_MS);
  const { dateStr: deadlineDateStr, hour: deadlineHour } = localDateAndHour(naiveDeadline, tz);
  if (!isInQuietHours(deadlineHour)) return naiveDeadline;

  if (EDGE_MODE === "EXTEND_PAST_QUIET") {
    const quietEndUtc = localHourToUtc(deadlineDateStr, QUIET_END_HOUR, tz);
    return new Date(quietEndUtc.getTime() + THRESHOLD_HOURS * HOUR_MS);
  }
  // CAP_AT_QUIET_START (default): must reply before quiet hours begin.
  return localHourToUtc(deadlineDateStr, QUIET_START_HOUR, tz);
}

/**
 * The deadline by which the NEXT follow-up after `lastSentAt` is due, or it's
 * late/missed. Flat FOLLOWUP_THRESHOLD_DAYS days, deliberately no quiet-hours
 * adjustment — a few hours don't matter against a multi-day cadence window.
 *
 * Kept in JS (not only in SQL) because missedFollowUpService needs the actual
 * deadline VALUE per backlog row, not just a late/not-late verdict — but it is
 * a plain additive offset, so the equivalent SQL predicate
 * (`occurred_at + N days < now()`) is provably identical, no drift risk.
 */
export function computeFollowUpDeadline(lastSentAt: Date): Date {
  return new Date(lastSentAt.getTime() + LATE_FOLLOWUP_THRESHOLD_DAYS * DAY_MS);
}

// UTC-bucketed date_trunc equivalent, matching how the other report series
// (ConnectionEventService, MessageEventService) bucket in SQL — no per-rep
// timezone shift for the CHART bucket, only for the deadline judgment itself.
function truncUTC(d: Date, granularity: "day" | "week" | "month"): string {
  const day0 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (granularity === "day") return day0.toISOString().slice(0, 10);
  if (granularity === "month") {
    return new Date(Date.UTC(day0.getUTCFullYear(), day0.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
  }
  // Monday-start week, matching Postgres date_trunc('week', ...).
  const dow = day0.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(day0);
  monday.setUTCDate(day0.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}

interface CandidateRow {
  userId: string;
  conversationKey: string;
  occurredAt: Date;
  respondsToAt: Date;
  selfTimeZone: string | null;
  isFollowUp: boolean;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
}

export interface LateRow extends CandidateRow {
  kind: "LATE_REPLY" | "LATE_FOLLOW_UP";
}

interface QueryOpts {
  userId?: string;
  restrictUserIds?: string[];
  selfLinkedinId?: string;
}

// Which column (and window) bounds a follow-up-lateness scan. null = no
// window at all (the Missed Follow-Up report's all-time history view).
type FollowUpDateBound =
  | { column: "occurred_at" | "responds_to_at"; from: Date; to: Date }
  | null;

export class LateMessageService {
  /**
   * Reply lateness only — the one kind that needs the JS quiet-hours math
   * above, since it isn't reasonably expressible as a single SQL predicate.
   * Narrowed to isFollowUp=false so this never fetches rows queryLateFollowUps
   * already owns.
   */
  private static async getLateReplyRows(
    from: Date,
    to: Date,
    opts: QueryOpts,
  ): Promise<LateRow[]> {
    const candidates = await prisma.messageEvent.findMany({
      where: {
        type: "SENT",
        isFollowUp: false,
        respondsToAt: { not: null },
        occurredAt: { gte: from, lte: to },
        ...(opts.userId
          ? { userId: opts.userId }
          : opts.restrictUserIds
            ? { userId: { in: opts.restrictUserIds } }
            : {}),
        ...(opts.selfLinkedinId ? { selfLinkedinId: opts.selfLinkedinId } : {}),
      },
      select: {
        userId: true,
        conversationKey: true,
        occurredAt: true,
        respondsToAt: true,
        selfTimeZone: true,
        isFollowUp: true,
        participantLinkedinId: true,
        selfLinkedinId: true,
      },
    });

    return candidates
      .filter((c): c is CandidateRow & { respondsToAt: Date } => c.respondsToAt !== null)
      .map((c) => ({ ...c, kind: "LATE_REPLY" as const }))
      .filter(
        (c) => c.occurredAt.getTime() > computeReplyDeadline(c.respondsToAt, c.selfTimeZone).getTime(),
      );
  }

  /**
   * Follow-up lateness, entirely in SQL. Shared by every follow-up-lateness
   * call site below — they differ only in which column (and window) bounds
   * the scan. Only genuinely-late rows are ever transferred from Postgres.
   */
  private static async queryLateFollowUps(
    bound: FollowUpDateBound,
    opts: QueryOpts,
  ): Promise<LateRow[]> {
    const ownerFilter = opts.userId
      ? Prisma.sql`AND user_id = ${opts.userId}`
      : opts.restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${opts.restrictUserIds})`
        : Prisma.empty;
    const accountFilter = opts.selfLinkedinId
      ? Prisma.sql`AND self_linkedin_id = ${opts.selfLinkedinId}`
      : Prisma.empty;
    const boundFilter =
      bound === null
        ? Prisma.empty
        : bound.column === "occurred_at"
          ? Prisma.sql`AND occurred_at >= ${bound.from} AND occurred_at <= ${bound.to}`
          : Prisma.sql`AND responds_to_at >= ${bound.from} AND responds_to_at <= ${bound.to}`;

    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        conversation_key: string;
        occurred_at: Date;
        responds_to_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
      }>
    >`
      SELECT user_id, conversation_key, occurred_at, responds_to_at,
             participant_linkedin_id, self_linkedin_id
      FROM message_events
      WHERE is_follow_up = true
        AND responds_to_at IS NOT NULL
        AND occurred_at > responds_to_at + (${LATE_FOLLOWUP_THRESHOLD_DAYS} * INTERVAL '1 day')
        ${boundFilter}
        ${ownerFilter}
        ${accountFilter}
    `;

    return rows.map((r) => ({
      userId: r.user_id,
      conversationKey: r.conversation_key,
      occurredAt: r.occurred_at,
      respondsToAt: r.responds_to_at,
      selfTimeZone: null,
      isFollowUp: true,
      participantLinkedinId: r.participant_linkedin_id,
      selfLinkedinId: r.self_linkedin_id,
      kind: "LATE_FOLLOW_UP" as const,
    }));
  }

  /**
   * Every SENT message in the window that responded to something later than
   * its deadline — replies and follow-ups combined. This is the general-
   * purpose entry point behind getSeries/getTotals/list: fetch ONCE here, then
   * derive whatever views you need from the same array via the pure
   * buildSeries/buildTotals helpers below, instead of each view re-querying
   * independently for the same window.
   */
  static async getLateRows(from: Date, to: Date, opts: QueryOpts = {}): Promise<LateRow[]> {
    const [replies, followUps] = await Promise.all([
      this.getLateReplyRows(from, to, opts),
      this.queryLateFollowUps({ column: "occurred_at", from, to }, opts),
    ]);
    return [...replies, ...followUps];
  }

  /** Pure aggregation: buckets already-fetched rows into the chart series. No DB access. */
  static buildSeries(
    rows: LateRow[],
    granularity: "day" | "week" | "month" = "day",
  ): Array<{ date: string; lateReplies: number; lateFollowUps: number }> {
    const buckets = new Map<string, { lateReplies: number; lateFollowUps: number }>();
    for (const r of rows) {
      const key = truncUTC(r.occurredAt, granularity);
      const b = buckets.get(key) ?? { lateReplies: 0, lateFollowUps: 0 };
      if (r.kind === "LATE_REPLY") b.lateReplies += 1;
      else b.lateFollowUps += 1;
      buckets.set(key, b);
    }
    return Array.from(buckets.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Pure aggregation: totals from already-fetched rows. No DB access. */
  static buildTotals(rows: LateRow[]): { lateReplies: number; lateFollowUps: number } {
    let lateReplies = 0;
    let lateFollowUps = 0;
    for (const r of rows) {
      if (r.kind === "LATE_REPLY") lateReplies += 1;
      else lateFollowUps += 1;
    }
    return { lateReplies, lateFollowUps };
  }

  /** Per-bucket late-reply / late-follow-up counts for the report's chart. */
  static async getSeries(
    from: Date,
    to: Date,
    opts: QueryOpts & { granularity?: "day" | "week" | "month" } = {},
  ): Promise<Array<{ date: string; lateReplies: number; lateFollowUps: number }>> {
    const rows = await this.getLateRows(from, to, opts);
    return this.buildSeries(rows, opts.granularity ?? "day");
  }

  /** Totals over the window, for the report's KPI cards. */
  static async getTotals(
    from: Date,
    to: Date,
    opts: QueryOpts = {},
  ): Promise<{ lateReplies: number; lateFollowUps: number }> {
    const rows = await this.getLateRows(from, to, opts);
    return this.buildTotals(rows);
  }

  /**
   * Paginated supporting-table rows: one row per conversation, deduped to its
   * MOST RECENT late instance in the window (a conversation late twice shows
   * once, as its latest occurrence) — "the specific LinkedIn profiles
   * involved", not a raw event count. Name/LinkedIn URL come from
   * MessageActivity, the only place the participant's display identity is
   * stored.
   */
  static async list(params: {
    page: number;
    limit: number;
    userId?: string;
    userIds?: string[];
    selfLinkedinId?: string;
    from: Date;
    to: Date;
  }): Promise<{
    data: Array<{
      userId: string;
      conversationKey: string;
      occurredAt: Date;
      kind: "LATE_REPLY" | "LATE_FOLLOW_UP";
      participantName: string | null;
      participantProfileUrl: string | null;
      selfName: string | null;
    }>;
    metadata: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));

    const sorted = (
      await this.getLateRows(params.from, params.to, {
        userId: params.userId,
        restrictUserIds: params.userIds,
        selfLinkedinId: params.selfLinkedinId,
      })
    ).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    // Dedupe to one row per (userId, conversationKey) — since `sorted` is
    // newest-first, the first occurrence seen per key is its latest instance.
    const dedupedByConversation = new Map<string, LateRow>();
    for (const r of sorted) {
      const key = `${r.userId}:${r.conversationKey}`;
      if (!dedupedByConversation.has(key)) dedupedByConversation.set(key, r);
    }
    const rows = Array.from(dedupedByConversation.values());

    const total = rows.length;
    const page_ = rows.slice((page - 1) * limit, (page - 1) * limit + limit);

    // Batch-resolve participant/self display identity from MessageActivity —
    // MessageEvent only stores ids, not names/urls.
    const pairs = Array.from(
      new Map(page_.map((r) => [`${r.userId}:${r.conversationKey}`, r])).values(),
    );
    const activities = pairs.length
      ? await prisma.messageActivity.findMany({
          where: {
            OR: pairs.map((r) => ({ userId: r.userId, conversationKey: r.conversationKey })),
          },
          select: {
            userId: true,
            conversationKey: true,
            participantName: true,
            participantProfileUrl: true,
            selfName: true,
          },
        })
      : [];
    const byKey = new Map(
      activities.map((a) => [`${a.userId}:${a.conversationKey}`, a]),
    );

    const data = page_.map((r) => {
      const activity = byKey.get(`${r.userId}:${r.conversationKey}`);
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

  /**
   * ALL-TIME (unbounded, not windowed by a report date range) LATE_FOLLOW_UP
   * instances: conversations where a follow-up eventually WAS sent, just
   * later than the FOLLOWUP_THRESHOLD_DAYS deadline. Used by
   * missedFollowUpService to build the "missed, then resolved late" history —
   * merged with the still-open backlog so an admin can see the full
   * lifecycle, not just current state. SQL-filtered like every follow-up
   * query above, so "all time" only ever transfers the rows that actually
   * qualify, not the full SENT-with-a-response history.
   */
  static async getFollowUpHistory(opts: QueryOpts): Promise<LateRow[]> {
    return this.queryLateFollowUps(null, opts);
  }

  /**
   * Resolved-late follow-up crossings whose DEADLINE falls in
   * [deadlineFrom, deadlineTo] — for the Missed Follow-Up report's chart.
   *
   * Bounded by respondsToAt (the message that should have gotten a
   * follow-up), translated back by the threshold, NOT by occurredAt (when
   * the eventual follow-up was actually sent) — a resolution can arrive
   * arbitrarily long after its trigger, so filtering on occurredAt wouldn't
   * let the requested date range actually bound the scan. isFollowUp=true
   * already implies type=SENT (see the (userId, isFollowUp, respondsToAt)
   * index), so this stays a targeted range scan regardless of table size.
   */
  static async getFollowUpDeadlineCrossings(
    deadlineFrom: Date,
    deadlineTo: Date,
    opts: QueryOpts,
  ): Promise<LateRow[]> {
    const respondsFrom = new Date(deadlineFrom.getTime() - LATE_FOLLOWUP_THRESHOLD_DAYS * DAY_MS);
    const respondsTo = new Date(deadlineTo.getTime() - LATE_FOLLOWUP_THRESHOLD_DAYS * DAY_MS);
    return this.queryLateFollowUps(
      { column: "responds_to_at", from: respondsFrom, to: respondsTo },
      opts,
    );
  }
}
