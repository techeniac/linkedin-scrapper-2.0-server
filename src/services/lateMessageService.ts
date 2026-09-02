// src/services/lateMessageService.ts
import { LateMessageRepository, ReplyCandidateRow } from "../repositories/lateMessageRepository";
import { resolveTimeZone, convertLocalTimeToUTC } from "./hubspotHelpers";
import {
  LATE_MSG_THRESHOLD_HOURS,
  LATE_MSG_QUIET_START_HOUR,
  LATE_MSG_QUIET_END_HOUR,
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
 *     Deadline = computeReplyDeadline() — evaluated in the REP's own local
 *     time (MessageEvent.selfTimeZone, browser-sourced, same as the app's
 *     existing userTimeZone pattern), against the quiet-hours window
 *     [LATE_MSG_QUIET_START_HOUR, LATE_MSG_QUIET_END_HOUR) — by default
 *     00:00-07:00:
 *       - A message that arrives DURING quiet hours gives the rep the rest
 *         of that calendar day: deadline = midnight at the start of the
 *         NEXT local day. Someone messaging at 3am isn't expected to be
 *         replied to before the workday even starts.
 *       - A message that arrives OUTSIDE quiet hours gets a flat
 *         LATE_MSG_THRESHOLD_HOURS (default 3) from when it arrived — no
 *         special-casing even if that deadline lands inside the quiet
 *         window (e.g. an 11:59pm message can have a deadline a few minutes
 *         past midnight; that's fine, it's still "reply within N hours").
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
 * fetched (LateMessageRepository.findSentReplyCandidates) and classified
 * here in JS. LATE_FOLLOW_UP has no such need — its deadline is a flat
 * day-offset — so it is filtered ENTIRELY IN SQL
 * (LateMessageRepository.queryLateFollowUps): only genuinely-late rows are
 * ever transferred, rather than fetching every SENT-with-a-response row and
 * discarding most of it in Node.
 *
 * All Prisma/raw-SQL access lives in LateMessageRepository — this service
 * holds only the business decisions (the deadline math, dedup/pagination
 * rules, how to shape a report series).
 */

// Thresholds validated and centralized in config/env.ts, alongside every
// other env-driven setting in this codebase.
const THRESHOLD_HOURS = LATE_MSG_THRESHOLD_HOURS;
const QUIET_START_HOUR = LATE_MSG_QUIET_START_HOUR;
const QUIET_END_HOUR = LATE_MSG_QUIET_END_HOUR;

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

// The next calendar date string after `dateStr` (both "YYYY-MM-DD"). Pure
// calendar-date arithmetic — treating dateStr as a UTC-midnight instant and
// adding a day is timezone-safe here since we only ever read back the date
// portion, never the time.
function nextDateStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const isInQuietHours = (hour: number): boolean =>
  hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;

/** The deadline by which a REPLY to `respondsToAt` is due, or it's late. */
export function computeReplyDeadline(respondsToAt: Date, timeZone?: string | null): Date {
  const tz = resolveTimeZone(timeZone ?? undefined);
  const { dateStr, hour } = localDateAndHour(respondsToAt, tz);

  if (isInQuietHours(hour)) {
    // Quiet-hours message: the rep gets the rest of that calendar day —
    // deadline is midnight at the START of the next local day.
    return localHourToUtc(nextDateStr(dateStr), 0, tz);
  }

  // Outside quiet hours: flat threshold from the message itself. No
  // capping/extending even if this lands inside quiet hours — a message
  // just before midnight is still just "reply within N hours."
  return new Date(respondsToAt.getTime() + THRESHOLD_HOURS * HOUR_MS);
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

/**
 * Collapses raw late-message EVENTS down to one per (kind, conversation,
 * calendar day) — a person late twice in one day counts once that day; the
 * same person late on 3 DIFFERENT days counts 3 times, once per day. This is
 * the single source of truth every "distinct count" below (buildSeries,
 * buildSeriesByOwner, buildTotals, and list's table rows) keys off, so a
 * day's chart number and that day's table row count always agree instead of
 * one counting raw events and the other deduping across the whole window.
 * Within a (kind, conversation, day) group, keeps the LATEST instance.
 */
function dedupeByConversationPerDay(rows: LateRow[]): LateRow[] {
  const byKey = new Map<string, LateRow>();
  for (const r of rows) {
    const key = `${r.kind}::${r.userId}::${r.conversationKey}::${truncUTC(r.occurredAt, "day")}`;
    const existing = byKey.get(key);
    if (!existing || r.occurredAt.getTime() > existing.occurredAt.getTime()) {
      byKey.set(key, r);
    }
  }
  return Array.from(byKey.values());
}

export interface LateRow {
  userId: string;
  conversationKey: string;
  occurredAt: Date;
  respondsToAt: Date;
  selfTimeZone: string | null;
  isFollowUp: boolean;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
  kind: "LATE_REPLY" | "LATE_FOLLOW_UP";
}

interface QueryOpts {
  userId?: string;
  restrictUserIds?: string[];
  selfLinkedinId?: string;
  selfLinkedinIds?: string[]; // multi-select account filter; takes precedence over selfLinkedinId
}

export class LateMessageService {
  /**
   * Reply lateness only — the one kind that needs the JS quiet-hours math
   * above, since it isn't reasonably expressible as a single SQL predicate.
   * Narrowed to isFollowUp=false so this never fetches rows queryLateFollowUps
   * already owns.
   */
  private static async getLateReplyRows(from: Date, to: Date, opts: QueryOpts): Promise<LateRow[]> {
    const candidates = await LateMessageRepository.findSentReplyCandidates(from, to, opts);

    return candidates
      .filter((c): c is ReplyCandidateRow & { respondsToAt: Date } => c.respondsToAt !== null)
      .map((c) => ({ ...c, kind: "LATE_REPLY" as const }))
      .filter(
        (c) => c.occurredAt.getTime() > computeReplyDeadline(c.respondsToAt, c.selfTimeZone).getTime(),
      );
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
      LateMessageRepository.queryLateFollowUps({ column: "occurred_at", from, to }, opts),
    ]);
    return [...replies, ...followUps];
  }

  /**
   * Pure aggregation: buckets already-fetched rows into the chart series. No
   * DB access. Counts DISTINCT (conversation, day) instances, not raw
   * events — see dedupeByConversationPerDay.
   */
  static buildSeries(
    rows: LateRow[],
    granularity: "day" | "week" | "month" = "day",
  ): Array<{ date: string; lateReplies: number; lateFollowUps: number }> {
    const deduped = dedupeByConversationPerDay(rows);
    const buckets = new Map<string, { lateReplies: number; lateFollowUps: number }>();
    for (const r of deduped) {
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

  /**
   * Same bucketing as buildSeries, but ALSO split by owner — one entry per
   * (date, userId), restricted to `ownerIds`. Pure aggregation over rows
   * ALREADY fetched by getLateRows — no second query, same principle as
   * buildSeries/buildTotals above.
   */
  static buildSeriesByOwner(
    rows: LateRow[],
    ownerIds: string[],
    granularity: "day" | "week" | "month" = "day",
  ): Array<{ date: string; userId: string; lateReplies: number; lateFollowUps: number }> {
    const allowed = new Set(ownerIds);
    const deduped = dedupeByConversationPerDay(rows);
    const buckets = new Map<string, { lateReplies: number; lateFollowUps: number }>();
    for (const r of deduped) {
      if (!allowed.has(r.userId)) continue;
      const key = `${truncUTC(r.occurredAt, granularity)}::${r.userId}`;
      const b = buckets.get(key) ?? { lateReplies: 0, lateFollowUps: 0 };
      if (r.kind === "LATE_REPLY") b.lateReplies += 1;
      else b.lateFollowUps += 1;
      buckets.set(key, b);
    }
    return Array.from(buckets.entries())
      .map(([key, v]) => {
        const [date, userId] = key.split("::");
        return { date, userId, ...v };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Same bucketing as buildSeriesByOwner, additionally split by LinkedIn
   * account — one entry per (date, userId, selfLinkedinId). Powers the chart
   * hover popup's per-account breakdown within an owner's segment.
   * `accountId` is `null` for rows captured before self-account tracking
   * existed — grouped as their own bucket rather than dropped.
   */
  static buildSeriesByOwnerAccount(
    rows: LateRow[],
    ownerIds: string[],
    granularity: "day" | "week" | "month" = "day",
  ): Array<{ date: string; userId: string; accountId: string | null; lateReplies: number; lateFollowUps: number }> {
    const allowed = new Set(ownerIds);
    const deduped = dedupeByConversationPerDay(rows);
    const buckets = new Map<string, { date: string; userId: string; accountId: string | null; lateReplies: number; lateFollowUps: number }>();
    for (const r of deduped) {
      if (!allowed.has(r.userId)) continue;
      const key = `${truncUTC(r.occurredAt, granularity)}::${r.userId}::${r.selfLinkedinId ?? ""}`;
      const b = buckets.get(key) ?? {
        date: truncUTC(r.occurredAt, granularity),
        userId: r.userId,
        accountId: r.selfLinkedinId,
        lateReplies: 0,
        lateFollowUps: 0,
      };
      if (r.kind === "LATE_REPLY") b.lateReplies += 1;
      else b.lateFollowUps += 1;
      buckets.set(key, b);
    }
    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Pure aggregation: totals from already-fetched rows. No DB access. Same
   * distinct (conversation, day) counting as buildSeries above.
   */
  static buildTotals(rows: LateRow[]): { lateReplies: number; lateFollowUps: number } {
    let lateReplies = 0;
    let lateFollowUps = 0;
    for (const r of dedupeByConversationPerDay(rows)) {
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
   * Paginated supporting-table rows: one row per (conversation, day), deduped
   * to that day's MOST RECENT late instance (a conversation late twice in one
   * day shows once, as that day's latest occurrence; late again on a
   * different day shows again as its own row) — matches buildSeries/
   * buildTotals above exactly, so a day's chart number and its table row
   * count always agree. Name/LinkedIn URL come from MessageActivity, the only
   * place the participant's display identity is stored.
   */
  static async list(params: {
    page: number;
    limit: number;
    userId?: string;
    userIds?: string[];
    selfLinkedinId?: string;
    selfLinkedinIds?: string[];
    kind?: "LATE_REPLY" | "LATE_FOLLOW_UP";
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
        selfLinkedinIds: params.selfLinkedinIds,
      })
    ).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    // Dedupe to one row per (userId, conversationKey, kind, day) — since
    // `sorted` is newest-first, the first occurrence seen per key is that
    // day's latest instance.
    const dedupedByConversation = new Map<string, LateRow>();
    for (const r of sorted) {
      const key = `${r.userId}:${r.conversationKey}:${r.kind}:${truncUTC(r.occurredAt, "day")}`;
      if (!dedupedByConversation.has(key)) dedupedByConversation.set(key, r);
    }
    const deduped = Array.from(dedupedByConversation.values());
    const rows = params.kind ? deduped.filter((r) => r.kind === params.kind) : deduped;

    const total = rows.length;
    const page_ = rows.slice((page - 1) * limit, (page - 1) * limit + limit);

    // Batch-resolve participant/self display identity from MessageActivity —
    // MessageEvent only stores ids, not names/urls.
    const pairs = Array.from(
      new Map(page_.map((r) => [`${r.userId}:${r.conversationKey}`, r])).values(),
    );
    const activities = await LateMessageRepository.findActivityIdentities(pairs);
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
    return LateMessageRepository.queryLateFollowUps(null, opts);
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
    return LateMessageRepository.queryLateFollowUps(
      { column: "responds_to_at", from: respondsFrom, to: respondsTo },
      opts,
    );
  }
}
