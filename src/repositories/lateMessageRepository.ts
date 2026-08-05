// src/repositories/lateMessageRepository.ts
//
// Data-access layer backing the Late Messages report. LateMessageService
// owns the business decisions (the quiet-hours reply-deadline math, which
// rows count as late, how to shape a report series); this file owns every
// Prisma/raw-SQL touch point.
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import { LATE_FOLLOWUP_THRESHOLD_DAYS } from "../config/env";

export interface ReplyCandidateRow {
  userId: string;
  conversationKey: string;
  occurredAt: Date;
  respondsToAt: Date | null;
  selfTimeZone: string | null;
  isFollowUp: boolean;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
}

export interface FollowUpRow {
  userId: string;
  conversationKey: string;
  occurredAt: Date;
  respondsToAt: Date;
  selfTimeZone: null;
  isFollowUp: true;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
  kind: "LATE_FOLLOW_UP";
}

export interface ActivityIdentity {
  userId: string;
  conversationKey: string;
  participantName: string | null;
  participantProfileUrl: string | null;
  selfName: string | null;
}

export interface QueryOpts {
  userId?: string;
  restrictUserIds?: string[];
  selfLinkedinId?: string;
  selfLinkedinIds?: string[];
}

// Which column (and window) bounds a follow-up-lateness scan. null = no
// window at all (the Missed Follow-Up report's all-time history view).
export type FollowUpDateBound = { column: "occurred_at" | "responds_to_at"; from: Date; to: Date } | null;

export class LateMessageRepository {
  /**
   * Every SENT message in the window that responded to someone else's
   * message (isFollowUp=false) — the RAW candidate set for reply-lateness.
   * Deadline filtering happens in the service (quiet-hours math isn't
   * expressible as a single SQL predicate — see LateMessageService).
   */
  static findSentReplyCandidates(from: Date, to: Date, opts: QueryOpts): Promise<ReplyCandidateRow[]> {
    return prisma.messageEvent.findMany({
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
        ...(opts.selfLinkedinIds?.length
          ? { selfLinkedinId: { in: opts.selfLinkedinIds } }
          : opts.selfLinkedinId
            ? { selfLinkedinId: opts.selfLinkedinId }
            : {}),
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
  }

  /**
   * Follow-up lateness, entirely in SQL (a flat day-offset predicate, unlike
   * reply lateness) — only genuinely-late rows are ever transferred from
   * Postgres. Shared by every follow-up-lateness call site; they differ only
   * in which column (and window) bounds the scan.
   */
  static async queryLateFollowUps(bound: FollowUpDateBound, opts: QueryOpts): Promise<FollowUpRow[]> {
    const ownerFilter = opts.userId
      ? Prisma.sql`AND user_id = ${opts.userId}`
      : opts.restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${opts.restrictUserIds})`
        : Prisma.empty;
    const accountFilter = opts.selfLinkedinIds?.length
      ? Prisma.sql`AND self_linkedin_id = ANY(${opts.selfLinkedinIds})`
      : opts.selfLinkedinId
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

    return rows.map(r => ({
      userId: r.user_id,
      conversationKey: r.conversation_key,
      occurredAt: r.occurred_at,
      respondsToAt: r.responds_to_at,
      selfTimeZone: null,
      isFollowUp: true as const,
      participantLinkedinId: r.participant_linkedin_id,
      selfLinkedinId: r.self_linkedin_id,
      kind: "LATE_FOLLOW_UP" as const,
    }));
  }

  /**
   * Batch-resolves participant/self display identity for a page of
   * (userId, conversationKey) pairs — MessageEvent only stores ids, not
   * names/urls; MessageActivity is the only place those are stored.
   */
  static findActivityIdentities(pairs: Array<{ userId: string; conversationKey: string }>): Promise<ActivityIdentity[]> {
    if (pairs.length === 0) return Promise.resolve([]);
    return prisma.messageActivity.findMany({
      where: { OR: pairs.map(r => ({ userId: r.userId, conversationKey: r.conversationKey })) },
      select: { userId: true, conversationKey: true, participantName: true, participantProfileUrl: true, selfName: true },
    });
  }
}
