// src/services/missedFollowUpService.ts
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
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
   */
  private static async getBacklog(opts: QueryOpts, now: Date): Promise<BacklogRow[]> {
    const ownerFilter = opts.userId
      ? Prisma.sql`AND user_id = ${opts.userId}`
      : opts.restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${opts.restrictUserIds})`
        : Prisma.empty;
    const accountFilter = opts.selfLinkedinId
      ? Prisma.sql`AND self_linkedin_id = ${opts.selfLinkedinId}`
      : Prisma.empty;

    const lastEvents = await prisma.$queryRaw<
      Array<{
        user_id: string;
        conversation_key: string;
        type: "SENT" | "RECEIVED";
        occurred_at: Date;
        participant_linkedin_id: string | null;
        self_linkedin_id: string | null;
      }>
    >`
      SELECT DISTINCT ON (user_id, conversation_key)
        user_id, conversation_key, type, occurred_at,
        participant_linkedin_id, self_linkedin_id
      FROM message_events
      WHERE true ${ownerFilter} ${accountFilter}
      ORDER BY user_id, conversation_key, occurred_at DESC
    `;

    return lastEvents
      .filter((e) => e.type === "SENT")
      .map((e) => ({
        userId: e.user_id,
        conversationKey: e.conversation_key,
        lastSentAt: e.occurred_at,
        deadline: computeFollowUpDeadline(e.occurred_at),
        participantLinkedinId: e.participant_linkedin_id,
        selfLinkedinId: e.self_linkedin_id,
      }))
      .filter((r) => now.getTime() > r.deadline.getTime());
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
  ): Promise<Array<{ date: string; count: number }>> {
    const [backlog, resolvedCrossings] = await Promise.all([
      this.getBacklog(opts, now),
      LateMessageService.getFollowUpDeadlineCrossings(from, to, opts),
    ]);

    const buckets = new Map<string, number>();
    const bump = (deadline: Date) => {
      if (deadline < from || deadline > to) return;
      const key = truncUTC(deadline);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    };
    for (const r of backlog) bump(r.deadline);
    for (const r of resolvedCrossings) bump(computeFollowUpDeadline(r.respondsToAt));

    return Array.from(buckets.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** The live backlog count, unbounded by date — for the report's KPI card. */
  static async getCurrentCount(opts: QueryOpts, now: Date): Promise<number> {
    return (await this.getBacklog(opts, now)).length;
  }

  /**
   * Paginated supporting-table rows — one row per conversation, showing its
   * CURRENT follow-up status: still overdue, or resolved (late). Not
   * windowed by date: covers all-time history, same as the KPI count.
   */
  static async listHistory(params: {
    page: number;
    limit: number;
    userId?: string;
    userIds?: string[];
    selfLinkedinId?: string;
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
      LateMessageService.getFollowUpHistory(opts, params.now),
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

    const rows = Array.from(byConversation.values()).sort((a, b) => b.recency - a.recency);
    const total = rows.length;
    const page_ = rows.slice((page - 1) * limit, (page - 1) * limit + limit);

    const activities = page_.length
      ? await prisma.messageActivity.findMany({
          where: {
            OR: page_.map((r) => ({ userId: r.userId, conversationKey: r.conversationKey })),
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
