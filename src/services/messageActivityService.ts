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

// Read params for the public, paginated message-activity list.
export interface ListMessagesParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  search?: string;
  userId?: string;
  userIds?: string[]; // restrict to a set of owners (used when no single userId)
  selfLinkedinId?: string; // the logged-in LinkedIn account that sent the messages
  hasReply?: boolean;
  isConversation?: boolean;
  lastFrom?: Date;
  lastTo?: Date;
}

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

  /**
   * Aggregate metrics. Scope: `userId` → that user; else `restrictUserIds` →
   * only those users (HubSpot-connected owners); else global.
   */
  static async getStats(
    userId?: string,
    restrictUserIds?: string[],
  ): Promise<MessageStats> {
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
      ${
        userId
          ? Prisma.sql`WHERE user_id = ${userId}`
          : restrictUserIds
            ? Prisma.sql`WHERE user_id = ANY(${restrictUserIds})`
            : Prisma.empty
      }
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

  // Columns a client is allowed to sort by (guards against arbitrary orderBy).
  private static readonly SORT_COLUMNS = new Set([
    "lastMessageAt",
    "firstMessageAt",
    "sentCount",
    "receivedCount",
    "followUpCount",
    "readCount",
    "createdAt",
  ]);

  /** Paginated / filtered / sorted list of message-activity rows (public read). */
  static async list(p: ListMessagesParams): Promise<{
    data: unknown[];
    metadata: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = Math.max(1, p.page || 1);
    const limit = Math.min(100, Math.max(1, p.limit || 10));
    const sortBy = this.SORT_COLUMNS.has(p.sortBy ?? "")
      ? (p.sortBy as string)
      : "lastMessageAt";
    const sortOrder: "asc" | "desc" = p.sortOrder === "asc" ? "asc" : "desc";

    const where: Prisma.MessageActivityWhereInput = {};
    if (p.userId) where.userId = p.userId;
    else if (p.userIds) where.userId = { in: p.userIds };
    if (p.selfLinkedinId) where.selfLinkedinId = p.selfLinkedinId;
    if (typeof p.hasReply === "boolean") where.hasReply = p.hasReply;
    if (typeof p.isConversation === "boolean") where.isConversation = p.isConversation;
    if (p.lastFrom || p.lastTo) {
      where.lastMessageAt = {};
      if (p.lastFrom) where.lastMessageAt.gte = p.lastFrom;
      if (p.lastTo) where.lastMessageAt.lte = p.lastTo;
    }
    if (p.search) {
      where.OR = [
        { participantName: { contains: p.search, mode: "insensitive" } },
        { participantProfileUrl: { contains: p.search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await prisma.$transaction([
      prisma.messageActivity.findMany({
        where,
        orderBy: { [sortBy]: sortOrder } as Prisma.MessageActivityOrderByWithRelationInput,
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          userId: true, // so the controller can map the owner to its HubSpot name
          conversationKey: true, // used to build the LinkedIn thread URL
          participantName: true,
          participantProfileUrl: true,
          selfName: true,
          sentCount: true,
          receivedCount: true,
          followUpCount: true,
          readCount: true,
          hasReply: true,
          isConversation: true,
          firstMessageAt: true,
          lastMessageAt: true,
          user: { select: { name: true } }, // owner NAME only (no email while public)
        },
      }),
      prisma.messageActivity.count({ where }),
    ]);

    return {
      data,
      metadata: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /**
   * Per-day message breakdown between [from, to] (inclusive), bucketed by
   * last_message_at: sent (Σ sent), replied (Σ received), followUps (Σ follow-up).
   */
  static async getSeries(
    userId: string | undefined,
    from: Date,
    to: Date,
    restrictUserIds?: string[],
    selfLinkedinId?: string,
    granularity: "day" | "week" | "month" = "day",
  ): Promise<
    Array<{ date: string; fresh: number; replied: number; followups: number }>
  > {
    const ownerFilter = userId
      ? Prisma.sql`AND user_id = ${userId}`
      : restrictUserIds
        ? Prisma.sql`AND user_id = ANY(${restrictUserIds})`
        : Prisma.empty;
    const accountFilter = selfLinkedinId
      ? Prisma.sql`AND self_linkedin_id = ${selfLinkedinId}`
      : Prisma.empty;
    // Whitelisted bucket unit for date_trunc (day / week[Mon start] / month).
    const bucket =
      granularity === "week" ? "week" : granularity === "month" ? "month" : "day";

    // `date` is the bucket-start (Mon for week, 1st for month) as YYYY-MM-DD.
    return prisma.$queryRaw`
      SELECT to_char(date_trunc(${bucket}, last_message_at), 'YYYY-MM-DD') AS date,
             GREATEST(COALESCE(SUM(sent_count), 0) - COALESCE(SUM(follow_up_count), 0), 0)::int AS fresh,
             COALESCE(SUM(received_count), 0)::int  AS replied,
             COALESCE(SUM(follow_up_count), 0)::int AS followups
      FROM message_activity
      WHERE last_message_at IS NOT NULL
        AND last_message_at >= ${from} AND last_message_at <= ${to}
        ${ownerFilter}
        ${accountFilter}
      GROUP BY 1
      ORDER BY 1
    `;
  }
}
