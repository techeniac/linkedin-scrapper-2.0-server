// src/repositories/messageActivityRepository.ts
//
// Data-access layer for message_activity. MessageActivityService owns the
// business decisions (the merge semantics documented on upsert, which
// columns are sortable, how to build the search/date filter); this file owns
// every Prisma/raw-SQL touch point.
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import prisma from "../config/prisma";

export interface UpsertMessageActivityRow {
  userId: string;
  conversationKey: string;
  participantLinkedinId: string | null;
  participantName: string | null;
  participantProfileUrl: string | null;
  selfLinkedinId: string | null;
  selfName: string | null;
  selfProfileUrl: string | null;
  sentCount: number;
  receivedCount: number;
  followUpCount: number;
  readCount: number;
  hasReply: boolean;
  isConversation: boolean;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
}

export class MessageActivityRepository {
  /**
   * Upserts one conversation's metrics, MERGING rather than overwriting — see
   * MessageActivityService.upsert for why each field's merge rule (GREATEST /
   * OR / LEAST / COALESCE) is safe against a partial re-fetch. Raw SQL because
   * Prisma cannot express GREATEST/LEAST against the existing row inside an
   * update.
   */
  static upsert(r: UpsertMessageActivityRow) {
    return prisma.$executeRaw`
      INSERT INTO message_activity (
        id, user_id, conversation_key,
        participant_linkedin_id, participant_name, participant_profile_url,
        self_linkedin_id, self_name, self_profile_url,
        sent_count, received_count, follow_up_count, read_count,
        has_reply, is_conversation,
        first_message_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${r.userId}, ${r.conversationKey},
        ${r.participantLinkedinId}, ${r.participantName}, ${r.participantProfileUrl},
        ${r.selfLinkedinId}, ${r.selfName}, ${r.selfProfileUrl},
        ${r.sentCount}, ${r.receivedCount}, ${r.followUpCount}, ${r.readCount},
        ${r.hasReply}, ${r.isConversation},
        ${r.firstMessageAt}, ${r.lastMessageAt},
        NOW(), NOW()
      )
      ON CONFLICT (user_id, conversation_key) DO UPDATE SET
        sent_count       = GREATEST(message_activity.sent_count,      EXCLUDED.sent_count),
        received_count   = GREATEST(message_activity.received_count,  EXCLUDED.received_count),
        follow_up_count  = GREATEST(message_activity.follow_up_count, EXCLUDED.follow_up_count),
        read_count       = GREATEST(message_activity.read_count,      EXCLUDED.read_count),
        has_reply        = message_activity.has_reply      OR EXCLUDED.has_reply,
        is_conversation  = message_activity.is_conversation OR EXCLUDED.is_conversation,
        first_message_at = LEAST(message_activity.first_message_at,   EXCLUDED.first_message_at),
        last_message_at  = GREATEST(message_activity.last_message_at, EXCLUDED.last_message_at),
        participant_linkedin_id = COALESCE(EXCLUDED.participant_linkedin_id, message_activity.participant_linkedin_id),
        participant_name        = COALESCE(EXCLUDED.participant_name,        message_activity.participant_name),
        participant_profile_url = COALESCE(EXCLUDED.participant_profile_url, message_activity.participant_profile_url),
        self_linkedin_id        = COALESCE(EXCLUDED.self_linkedin_id,        message_activity.self_linkedin_id),
        self_name               = COALESCE(EXCLUDED.self_name,               message_activity.self_name),
        self_profile_url        = COALESCE(EXCLUDED.self_profile_url,        message_activity.self_profile_url),
        updated_at = NOW()
    `;
  }

  /** Aggregate metrics for an optional owner/owner-set scope — see MessageActivityService.getStats. */
  static async getStats(
    userId?: string,
    restrictUserIds?: string[],
  ): Promise<{ sent: number; read: number; followups: number; replied: number; received: number; conversations: number }> {
    const rows = await prisma.$queryRaw<
      Array<{ sent: number; read: number; followups: number; replied: number; received: number; conversations: number }>
    >`
      SELECT
        COALESCE(SUM(sent_count), 0)::int      AS sent,
        COALESCE(SUM(read_count), 0)::int      AS read,
        COALESCE(SUM(follow_up_count), 0)::int AS followups,
        COUNT(*) FILTER (WHERE has_reply)::int AS replied,
        COALESCE(SUM(received_count), 0)::int  AS received,
        COUNT(*) FILTER (WHERE is_conversation)::int AS conversations
      FROM message_activity
      ${
        userId
          ? Prisma.sql`WHERE user_id = ${userId}`
          : restrictUserIds
            ? Prisma.sql`WHERE user_id = ANY(${restrictUserIds})`
            : Prisma.empty
      }
    `;
    return (
      rows[0] ?? { sent: 0, read: 0, followups: 0, replied: 0, received: 0, conversations: 0 }
    );
  }

  /** One user's stats + global totals, computed in ONE query — see MessageActivityService.getUserAndGlobalStats. */
  static async getUserAndGlobalStats(userId: string): Promise<{
    user_sent: number;
    user_read: number;
    user_followups: number;
    user_replied: number;
    user_received: number;
    user_conversations: number;
    global_sent: number;
    global_read: number;
    global_followups: number;
    global_replied: number;
    global_received: number;
    global_conversations: number;
  }> {
    const rows = await prisma.$queryRaw<
      Array<{
        user_sent: number;
        user_read: number;
        user_followups: number;
        user_replied: number;
        user_received: number;
        user_conversations: number;
        global_sent: number;
        global_read: number;
        global_followups: number;
        global_replied: number;
        global_received: number;
        global_conversations: number;
      }>
    >`
      SELECT
        COALESCE(SUM(sent_count)      FILTER (WHERE user_id = ${userId}), 0)::int AS user_sent,
        COALESCE(SUM(read_count)      FILTER (WHERE user_id = ${userId}), 0)::int AS user_read,
        COALESCE(SUM(follow_up_count) FILTER (WHERE user_id = ${userId}), 0)::int AS user_followups,
        COUNT(*) FILTER (WHERE user_id = ${userId} AND has_reply)::int AS user_replied,
        COALESCE(SUM(received_count) FILTER (WHERE user_id = ${userId}), 0)::int  AS user_received,
        COUNT(*) FILTER (WHERE user_id = ${userId} AND is_conversation)::int AS user_conversations,
        COALESCE(SUM(sent_count), 0)::int      AS global_sent,
        COALESCE(SUM(read_count), 0)::int      AS global_read,
        COALESCE(SUM(follow_up_count), 0)::int AS global_followups,
        COUNT(*) FILTER (WHERE has_reply)::int AS global_replied,
        COALESCE(SUM(received_count), 0)::int  AS global_received,
        COUNT(*) FILTER (WHERE is_conversation)::int AS global_conversations
      FROM message_activity
    `;
    return (
      rows[0] ?? {
        user_sent: 0,
        user_read: 0,
        user_followups: 0,
        user_replied: 0,
        user_received: 0,
        user_conversations: 0,
        global_sent: 0,
        global_read: 0,
        global_followups: 0,
        global_replied: 0,
        global_received: 0,
        global_conversations: 0,
      }
    );
  }

}
