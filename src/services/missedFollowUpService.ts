// src/services/missedFollowUpService.ts
import { MissedFollowUpRepository } from "../repositories/missedFollowUpRepository";
import { LateMessageRepository } from "../repositories/lateMessageRepository";
import { computeFollowUpDeadline, LateMessageService } from "./lateMessageService";

/**
 * Missed Follow-Up report: conversations whose last message is OURS, nobody
 * has sent anything since (not us, not them), and the follow-up deadline
 * (lateMessageService.computeFollowUpDeadline — flat LATE_FOLLOW_UP_
 * THRESHOLD_DAYS, no quiet hours) has already passed as of right now.
 *
 * Deliberately narrower than the Late Messages report: this only covers "we
 * never sent the next follow-up," not "they messaged and we never replied" —
 * that's report 3's LATE_REPLY territory (a reply that's very late), per the
 * report's literal wording ("follow-up messages were not sent").
 *
 * "Missed" has no natural event date — nothing happened, so there's nothing
 * to timestamp. Two different views read this differently:
 *
 * - getCurrentCount() is a LIVE snapshot (like ConnectionService.getStats's
 *   `pending`) — "how many are open right now." Changes as items resolve;
 *   that's intentional, it's the pulse-check KPI number.
 *
 * - getSeries() (the chart) and listHistory() (the supporting table) are
 *   both STABLE — message_events is itself an immutable, append-only log,
 *   so "did this crossing happen on day X" never changes once computed,
 *   regardless of when you ask or what's since been resolved. Both combine
 *   two sources:
 *     - STILL_MISSING : from getBacklog() — no follow-up sent yet, overdue.
 *     - RESOLVED_LATE : from LateMessageService.getFollowUpDeadlineCrossings
 *       (getSeries) / getFollowUpHistory (listHistory) — a follow-up WAS
 *       eventually sent, just later than the deadline. This is the exact
 *       same LATE_FOLLOW_UP data report 3 already computes; nothing new is
 *       written anywhere, it's just re-read from a different angle.
 *   The two views combine them differently, because they answer different
 *   questions:
 *     - listHistory answers "what's this conversation's status" → one row
 *       per conversation, STILL_MISSING always wins over an older
 *       RESOLVED_LATE (an open item is always more recent than a resolved
 *       one, since resolving one requires something sent after it).
 *     - getSeries answers "how many crossings happened on day X" → every
 *       distinct crossing counts, NOT deduped per conversation. A
 *       conversation that was late in March and is unresolved again in June
 *       contributes to BOTH months' buckets — deduping to "current status"
 *       here would silently drop March's real, already-happened crossing
 *       the moment June's happened, reintroducing the exact instability
 *       this was built to avoid.
 */

interface BacklogRow {
  userId: string;
  conversationKey: string;
  lastSentAt: Date;
  deadline: Date;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
}

interface QueryOpts {
  userId?: string;
  restrictUserIds?: string[];
  selfLinkedinId?: string;
  selfLinkedinIds?: string[]; // multi-select account filter; takes precedence over selfLinkedinId
}

function truncUTC(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

export class MissedFollowUpService {
  /**
   * The current backlog: every conversation whose last-ever event is a SENT
   * message with no response since, and whose deadline has passed as of
   * `now`. Uses DISTINCT ON to get exactly the latest event per conversation
   * — see the composite index on (userId, conversationKey, occurredAt).
   *
   * Public (not just for missedFollowUpService's own use) so callers needing
   * BOTH the backlog and a derived value (its count, or a chart series built
   * from it) can fetch it ONCE and pass the same array to buildSeries below
   * and/or read `.length` themselves — see publicController's getSummary,
   * which previously called the equivalent of this query twice per request.
   *
   * TIEBREAK: `(type = 'RECEIVED') DESC` makes the "last event" choice
   * deterministic on an exact-timestamp tie between a SENT and a RECEIVED
   * event (millisecond-precision timestamps can coincide). Without a
   * tiebreaker, DISTINCT ON's pick on a tie is unspecified by Postgres and
   * could vary between runs. Ties resolve toward RECEIVED — i.e. toward NOT
   * flagging a backlog item — since this is an inherently ambiguous instant
   * with no way to know which side "really" came last.
   */
  static async getBacklog(opts: QueryOpts, now: Date): Promise<BacklogRow[]> {
    const lastEvents = await MissedFollowUpRepository.findLastEventPerConversation(opts);

    return lastEvents
      .filter((e) => e.type === "SENT")
      .map((e) => ({
        userId: e.userId,
        conversationKey: e.conversationKey,
        lastSentAt: e.occurredAt,
        deadline: computeFollowUpDeadline(e.occurredAt),
        participantLinkedinId: e.participantLinkedinId,
        selfLinkedinId: e.selfLinkedinId,
      }))
      .filter((r) => now.getTime() > r.deadline.getTime());
  }

  /**
   * Pure aggregation over an already-fetched backlog + resolved-crossings
   * pair — no DB access. Split out so a caller that already has both arrays
   * (again, publicController's getSummary) can build the series without a
   * second round of queries.
   */
  static buildSeries(
    backlog: BacklogRow[],
    resolvedCrossings: Array<{ respondsToAt: Date }>,
    from: Date,
    to: Date,
  ): Array<{ date: string; stillMissing: number; resolvedLate: number }> {
    const buckets = new Map<string, { stillMissing: number; resolvedLate: number }>();
    const bump = (deadline: Date, field: "stillMissing" | "resolvedLate") => {
      if (deadline < from || deadline > to) return;
      const key = truncUTC(deadline);
      const b = buckets.get(key) ?? { stillMissing: 0, resolvedLate: 0 };
      b[field] += 1;
      buckets.set(key, b);
    };
    for (const r of backlog) bump(r.deadline, "stillMissing");
    for (const r of resolvedCrossings) bump(computeFollowUpDeadline(r.respondsToAt), "resolvedLate");

    return Array.from(buckets.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Same combination as buildSeries, but ALSO split by owner — one entry per
   * (date, userId), restricted to `ownerIds`. Pure aggregation over rows
   * ALREADY fetched by getBacklog / getFollowUpDeadlineCrossings — no second
   * query. Powers the report chart's per-Sales-Person stacked segments.
   */
  static buildSeriesByOwner(
    backlog: BacklogRow[],
    resolvedCrossings: Array<{ userId: string; respondsToAt: Date }>,
    ownerIds: string[],
    from: Date,
    to: Date,
  ): Array<{ date: string; userId: string; stillMissing: number; resolvedLate: number }> {
    const allowed = new Set(ownerIds);
    const buckets = new Map<string, { stillMissing: number; resolvedLate: number }>();
    const bump = (userId: string, deadline: Date, field: "stillMissing" | "resolvedLate") => {
      if (!allowed.has(userId)) return;
      if (deadline < from || deadline > to) return;
      const key = `${truncUTC(deadline)}::${userId}`;
      const b = buckets.get(key) ?? { stillMissing: 0, resolvedLate: 0 };
      b[field] += 1;
      buckets.set(key, b);
    };
    for (const r of backlog) bump(r.userId, r.deadline, "stillMissing");
    for (const r of resolvedCrossings) bump(r.userId, computeFollowUpDeadline(r.respondsToAt), "resolvedLate");

    return Array.from(buckets.entries())
      .map(([key, v]) => {
        const [date, userId] = key.split("::");
        return { date, userId, ...v };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Same combination as buildSeriesByOwner, additionally split by LinkedIn
   * account — one entry per (date, userId, selfLinkedinId). Powers the chart
   * hover popup's per-account breakdown within an owner's segment.
   * `accountId` is `null` for rows captured before self-account tracking
   * existed — grouped as their own bucket rather than dropped.
   */
  static buildSeriesByOwnerAccount(
    backlog: BacklogRow[],
    resolvedCrossings: Array<{ userId: string; selfLinkedinId: string | null; respondsToAt: Date }>,
    ownerIds: string[],
    from: Date,
    to: Date,
  ): Array<{ date: string; userId: string; accountId: string | null; stillMissing: number; resolvedLate: number }> {
    const allowed = new Set(ownerIds);
    const buckets = new Map<
      string,
      { date: string; userId: string; accountId: string | null; stillMissing: number; resolvedLate: number }
    >();
    const bump = (
      userId: string,
      accountId: string | null,
      deadline: Date,
      field: "stillMissing" | "resolvedLate",
    ) => {
      if (!allowed.has(userId)) return;
      if (deadline < from || deadline > to) return;
      const date = truncUTC(deadline);
      const key = `${date}::${userId}::${accountId ?? ""}`;
      const b = buckets.get(key) ?? { date, userId, accountId, stillMissing: 0, resolvedLate: 0 };
      b[field] += 1;
      buckets.set(key, b);
    };
    for (const r of backlog) bump(r.userId, r.selfLinkedinId, r.deadline, "stillMissing");
    for (const r of resolvedCrossings) bump(r.userId, r.selfLinkedinId, computeFollowUpDeadline(r.respondsToAt), "resolvedLate");

    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * A STABLE count of deadline crossings per bucket — unlike getCurrentCount
   * (a live snapshot), this doesn't change retroactively as items get
   * resolved, because it's the UNION of two independent, non-overlapping
   * sources, each contributing every distinct crossing rather than one
   * status per conversation:
   *   - still-open backlog items (getBacklog) — deadline = lastSentAt + N
   *   - resolved-but-late crossings (LateMessageService.
   *     getFollowUpDeadlineCrossings) — deadline = respondsToAt + N
   * These can't double-count the same crossing: a backlog row's trigger is
   * "the last message, nothing sent after it since"; a resolved row's
   * trigger already HAS something sent after it (that's what resolved it).
   * The same message CAN appear as the trigger of one and the response
   * closing a different, earlier crossing — that's two distinct incidents on
   * two different dates, not the same one counted twice. Deliberately NOT
   * deduped per conversation (unlike listHistory, which wants current status,
   * not a historical count) — a conversation late twice on different dates
   * must contribute to both of those dates' buckets.
   */
  static async getSeries(
    from: Date,
    to: Date,
    opts: QueryOpts,
    now: Date,
  ): Promise<Array<{ date: string; stillMissing: number; resolvedLate: number }>> {
    const [backlog, resolvedCrossings] = await Promise.all([
      this.getBacklog(opts, now),
      LateMessageService.getFollowUpDeadlineCrossings(from, to, opts),
    ]);
    return this.buildSeries(backlog, resolvedCrossings, from, to);
  }

  /** The live backlog count, unbounded by date — for the report's KPI card. */
  static async getCurrentCount(opts: QueryOpts, now: Date): Promise<number> {
    return (await this.getBacklog(opts, now)).length;
  }

  /**
   * Paginated supporting-table rows — one row per conversation, showing its
   * CURRENT follow-up status: still overdue, or resolved (late). Windowed by
   * `deadline` (the same field buildSeries buckets the chart on) over
   * [from, to] — so every row shown here always has a matching bar on the
   * chart for the same date range, instead of the table silently including
   * all-time history the chart's window wouldn't plot.
   */
  static async listHistory(params: {
    page: number;
    limit: number;
    userId?: string;
    userIds?: string[];
    selfLinkedinId?: string;
    selfLinkedinIds?: string[];
    status?: "STILL_MISSING" | "RESOLVED_LATE";
    from: Date;
    to: Date;
    now: Date;
  }): Promise<{
    data: Array<{
      userId: string;
      conversationKey: string;
      status: "STILL_MISSING" | "RESOLVED_LATE";
      missedSince: Date; // the SENT message that should have gotten a follow-up
      deadline: Date;
      followUpSentAt: Date | null; // set only for RESOLVED_LATE
      daysLate: number | null; // set only for RESOLVED_LATE
      participantName: string | null;
      participantProfileUrl: string | null;
      selfName: string | null;
    }>;
    metadata: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));
    const opts = {
      userId: params.userId,
      restrictUserIds: params.userIds,
      selfLinkedinId: params.selfLinkedinId,
      selfLinkedinIds: params.selfLinkedinIds,
    };

    interface HistoryRow {
      userId: string;
      conversationKey: string;
      status: "STILL_MISSING" | "RESOLVED_LATE";
      missedSince: Date;
      deadline: Date;
      followUpSentAt: Date | null;
      daysLate: number | null;
      recency: number; // sort key: most relevant timestamp, epoch ms
    }

    const [backlog, resolvedHistory] = await Promise.all([
      this.getBacklog(opts, params.now),
      LateMessageService.getFollowUpHistory(opts),
    ]);

    const byConversation = new Map<string, HistoryRow>();

    // RESOLVED_LATE first, so STILL_MISSING (added next) always overwrites —
    // an open backlog item is always more recent than any resolved instance.
    for (const r of resolvedHistory) {
      const key = `${r.userId}:${r.conversationKey}`;
      const deadline = computeFollowUpDeadline(r.respondsToAt);
      const daysLate = Math.round((r.occurredAt.getTime() - deadline.getTime()) / (24 * 60 * 60 * 1000));
      const existing = byConversation.get(key);
      // A conversation can have several resolved-late rounds; keep the latest.
      if (existing && existing.recency > r.occurredAt.getTime()) continue;
      byConversation.set(key, {
        userId: r.userId,
        conversationKey: r.conversationKey,
        status: "RESOLVED_LATE",
        missedSince: r.respondsToAt,
        deadline,
        followUpSentAt: r.occurredAt,
        daysLate,
        recency: r.occurredAt.getTime(),
      });
    }
    for (const r of backlog) {
      const key = `${r.userId}:${r.conversationKey}`;
      byConversation.set(key, {
        userId: r.userId,
        conversationKey: r.conversationKey,
        status: "STILL_MISSING",
        missedSince: r.lastSentAt,
        deadline: r.deadline,
        followUpSentAt: null,
        daysLate: null,
        recency: r.lastSentAt.getTime(),
      });
    }

    const windowed = Array.from(byConversation.values()).filter(
      (r) => r.deadline >= params.from && r.deadline <= params.to,
    );
    const allRows = windowed.sort((a, b) => b.recency - a.recency);
    const rows = params.status ? allRows.filter((r) => r.status === params.status) : allRows;
    const total = rows.length;
    const page_ = rows.slice((page - 1) * limit, (page - 1) * limit + limit);

    const activities = await LateMessageRepository.findActivityIdentities(
      page_.map((r) => ({ userId: r.userId, conversationKey: r.conversationKey })),
    );
    const byKey = new Map(activities.map((a) => [`${a.userId}:${a.conversationKey}`, a]));

    const data = page_.map((r) => {
      const activity = byKey.get(`${r.userId}:${r.conversationKey}`);
      return {
        userId: r.userId,
        conversationKey: r.conversationKey,
        status: r.status,
        missedSince: r.missedSince,
        deadline: r.deadline,
        followUpSentAt: r.followUpSentAt,
        daysLate: r.daysLate,
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
