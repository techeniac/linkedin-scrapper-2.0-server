// src/services/messageActivityService.ts
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";

/**
 * Per-user LinkedIn messaging metrics, one row per conversation.
 *
 * The extension derives a conversation's numbers from LinkedIn's messenger data
 * and upserts them here; we aggregate into per-user + global stats:
 *   - sent          : messages the user sent
 *   - read          : the user's sent messages the recipient has seen
 *   - replied       : conversations where the other party answered
 *   - followUps     : re-pings the user sent with no reply in between
 *   - conversations : threads with >2 messages and both sides participating
 */

export interface MessageActivityInput {
  conversationKey: string;
  participantLinkedinId?: string | null;
  participantName?: string | null;
  participantProfileUrl?: string | null;
  selfLinkedinId?: string | null;
  selfName?: string | null;
  selfProfileUrl?: string | null;
  sentCount: number;
  receivedCount: number;
  followUpCount: number;
  readCount: number;
  hasReply: boolean;
  isConversation: boolean;
  firstMessageAt?: string | null; // ISO or epoch-ms string
  lastMessageAt?: string | null;
}

export interface MessageStats {
  sent: number;
  read: number;
  replied: number; // conversations that got a reply
  followUps: number;
  conversations: number; // real back-and-forth threads
}

const toDate = (v?: string | null): Date | null => {
  if (!v) return null;
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

export class MessageActivityService {
  /** Upsert one conversation's metrics for a user (unique per conversationKey). */
  static async upsert(
    userId: string,
    input: MessageActivityInput,
  ): Promise<void> {
    const counts = {
      sentCount: input.sentCount,
      receivedCount: input.receivedCount,
      followUpCount: input.followUpCount,
      readCount: input.readCount,
      hasReply: input.hasReply,
      isConversation: input.isConversation,
      firstMessageAt: toDate(input.firstMessageAt),
      lastMessageAt: toDate(input.lastMessageAt),
    };

    await prisma.messageActivity.upsert({
      where: {
        userId_conversationKey: {
          userId,
          conversationKey: input.conversationKey,
        },
      },
      create: {
        userId,
        conversationKey: input.conversationKey,
        participantLinkedinId: input.participantLinkedinId ?? null,
        participantName: input.participantName ?? null,
        participantProfileUrl: input.participantProfileUrl ?? null,
        selfLinkedinId: input.selfLinkedinId ?? null,
        selfName: input.selfName ?? null,
        selfProfileUrl: input.selfProfileUrl ?? null,
        ...counts,
      },
      update: {
        ...counts,
        // Only fill identity fields, never wipe a known value with null.
        ...(input.participantName != null && {
          participantName: input.participantName,
        }),
        ...(input.participantLinkedinId != null && {
          participantLinkedinId: input.participantLinkedinId,
        }),
        ...(input.participantProfileUrl != null && {
          participantProfileUrl: input.participantProfileUrl,
        }),
        ...(input.selfLinkedinId != null && {
          selfLinkedinId: input.selfLinkedinId,
        }),
        ...(input.selfName != null && { selfName: input.selfName }),
        ...(input.selfProfileUrl != null && {
          selfProfileUrl: input.selfProfileUrl,
        }),
      },
    });
  }

  /** Aggregate metrics for one user, or globally when userId is omitted. */
  static async getStats(userId?: string): Promise<MessageStats> {
    // Single round trip: sums + conditional counts in one query (::int casts so
    // Postgres bigints come back as plain numbers, not BigInt).
    const rows = await prisma.$queryRaw<
      Array<{
        sent: number;
        read: number;
        followups: number;
        replied: number;
        conversations: number;
      }>
    >`
      SELECT
        COALESCE(SUM(sent_count), 0)::int      AS sent,
        COALESCE(SUM(read_count), 0)::int      AS read,
        COALESCE(SUM(follow_up_count), 0)::int AS followups,
        COALESCE(SUM(received_count), 0)::int  AS replied,
        COUNT(*) FILTER (WHERE is_conversation)::int AS conversations
      FROM message_activity
      ${userId ? Prisma.sql`WHERE user_id = ${userId}` : Prisma.empty}
    `;
    const r = rows[0];
    return {
      sent: r?.sent ?? 0,
      read: r?.read ?? 0,
      followUps: r?.followups ?? 0,
      replied: r?.replied ?? 0,
      conversations: r?.conversations ?? 0,
    };
  }

  /** The user's stats + global totals, computed in ONE query. */
  static async getUserAndGlobalStats(
    userId: string,
  ): Promise<{ user: MessageStats; global: MessageStats }> {
    const rows = await prisma.$queryRaw<
      Array<{
        user_sent: number;
        user_read: number;
        user_followups: number;
        user_replied: number;
        user_conversations: number;
        global_sent: number;
        global_read: number;
        global_followups: number;
        global_replied: number;
        global_conversations: number;
      }>
    >`
      SELECT
        COALESCE(SUM(sent_count)      FILTER (WHERE user_id = ${userId}), 0)::int AS user_sent,
        COALESCE(SUM(read_count)      FILTER (WHERE user_id = ${userId}), 0)::int AS user_read,
        COALESCE(SUM(follow_up_count) FILTER (WHERE user_id = ${userId}), 0)::int AS user_followups,
        COALESCE(SUM(received_count) FILTER (WHERE user_id = ${userId}), 0)::int  AS user_replied,
        COUNT(*) FILTER (WHERE user_id = ${userId} AND is_conversation)::int AS user_conversations,
        COALESCE(SUM(sent_count), 0)::int      AS global_sent,
        COALESCE(SUM(read_count), 0)::int      AS global_read,
        COALESCE(SUM(follow_up_count), 0)::int AS global_followups,
        COALESCE(SUM(received_count), 0)::int  AS global_replied,
        COUNT(*) FILTER (WHERE is_conversation)::int AS global_conversations
      FROM message_activity
    `;
    const r = rows[0];
    return {
      user: {
        sent: r?.user_sent ?? 0,
        read: r?.user_read ?? 0,
        followUps: r?.user_followups ?? 0,
        replied: r?.user_replied ?? 0,
        conversations: r?.user_conversations ?? 0,
      },
      global: {
        sent: r?.global_sent ?? 0,
        read: r?.global_read ?? 0,
        followUps: r?.global_followups ?? 0,
        replied: r?.global_replied ?? 0,
        conversations: r?.global_conversations ?? 0,
      },
    };
  }
}
