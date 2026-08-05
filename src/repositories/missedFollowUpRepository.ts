// src/repositories/missedFollowUpRepository.ts
//
// Data-access layer backing the Missed Follow-Up report's backlog scan.
// MissedFollowUpService owns the business decisions (which deadline rule
// applies, backlog vs. resolved-late combination rules); this file owns the
// raw-SQL touch point. Activity-identity lookups reuse LateMessageRepository
// rather than duplicating that query.
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";

export interface LastEventRow {
  userId: string;
  conversationKey: string;
  type: "SENT" | "RECEIVED";
  occurredAt: Date;
  participantLinkedinId: string | null;
  selfLinkedinId: string | null;
}

export interface QueryOpts {
  userId?: string;
  restrictUserIds?: string[];
  selfLinkedinId?: string;
  selfLinkedinIds?: string[];
}

export class MissedFollowUpRepository {
  /**
   * The most recent message_events row per conversation — the raw material
   * for the backlog scan (MissedFollowUpService.getBacklog filters this down
   * to SENT-last, deadline-passed conversations). Uses DISTINCT ON to get
   * exactly the latest event per conversation — see the composite index on
   * (userId, conversationKey, occurredAt).
   *
   * TIEBREAK: `(type = 'RECEIVED') DESC` makes the "last event" choice
   * deterministic on an exact-timestamp tie between a SENT and a RECEIVED
   * event (millisecond-precision timestamps can coincide). Without a
   * tiebreaker, DISTINCT ON's pick on a tie is unspecified by Postgres and
   * could vary between runs. Ties resolve toward RECEIVED — i.e. toward NOT
   * flagging a backlog item — since this is an inherently ambiguous instant
   * with no way to know which side "really" came last.
   */
  static async findLastEventPerConversation(opts: QueryOpts): Promise<LastEventRow[]> {
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

    const rows = await prisma.$queryRaw<
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
      ORDER BY user_id, conversation_key, occurred_at DESC, (type = 'RECEIVED') DESC
    `;

    return rows.map(r => ({
      userId: r.user_id,
      conversationKey: r.conversation_key,
      type: r.type,
      occurredAt: r.occurred_at,
      participantLinkedinId: r.participant_linkedin_id,
      selfLinkedinId: r.self_linkedin_id,
    }));
  }
}
