// src/services/messageActivityService.ts
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
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
  /**
   * Conversations that got a reply — a CONVERSATION count, matching the
   * documented intent. Previously this summed `received_count` (total messages
   * received), so one talkative prospect sending 30 messages read as 30
   * "replies". The raw message total is now exposed as `received`.
   */
  replied: number;
  received: number; // total messages received (Σ received_count)
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
  /**
   * Upsert one conversation's metrics for a user (unique per conversationKey),
   * MERGING rather than overwriting.
   *
   * Why merge: the extension derives these counts from whatever LinkedIn has
   * loaded in the current page session, and its in-memory state is empty on
   * every page load. LinkedIn's messenger queries are paginated
   * (`messengerMessagesBySyncToken` / `…ByAnchorTimestamp` carry a `count:`),
   * so re-opening a long thread yields only the newest slice. A plain overwrite
   * therefore replaced a correct high count with a partial low one — counts
   * silently regressed on every revisit.
   *
   * Merge semantics (all monotonic, so a partial fetch can only ever add):
   *   counts        → GREATEST(stored, incoming)
   *   booleans      → stored OR incoming (false never un-sets true)
   *   firstMessageAt→ LEAST  (earliest wins)
   *   lastMessageAt → GREATEST (latest wins)
   *   identity      → COALESCE(incoming, stored) — never wipe a known value
   *
   * Postgres LEAST/GREATEST ignore NULLs (returning NULL only when every
   * argument is NULL), which is exactly the behaviour we want for the dates.
   *
   * Raw SQL rather than prisma.upsert() because Prisma cannot express
   * GREATEST/LEAST against the existing row inside an update.
   */
  static async upsert(
    userId: string,
    input: MessageActivityInput,
  ): Promise<void> {
    const firstAt = toDate(input.firstMessageAt);
    const lastAt = toDate(input.lastMessageAt);

    // `id` has no database-level default (Prisma generates uuids client-side),
    // and `updated_at` is NOT NULL without a default, so both must be supplied.
    await prisma.$executeRaw`
      INSERT INTO message_activity (
        id, user_id, conversation_key,
        participant_linkedin_id, participant_name, participant_profile_url,
        self_linkedin_id, self_name, self_profile_url,
        sent_count, received_count, follow_up_count, read_count,
        has_reply, is_conversation,
        first_message_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${userId}, ${input.conversationKey},
        ${input.participantLinkedinId ?? null}, ${input.participantName ?? null}, ${input.participantProfileUrl ?? null},
        ${input.selfLinkedinId ?? null}, ${input.selfName ?? null}, ${input.selfProfileUrl ?? null},
        ${input.sentCount}, ${input.receivedCount}, ${input.followUpCount}, ${input.readCount},
        ${input.hasReply}, ${input.isConversation},
        ${firstAt}, ${lastAt},
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
        received: number;
        conversations: number;
      }>
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
    const r = rows[0];
    return {
      sent: r?.sent ?? 0,
      read: r?.read ?? 0,
      followUps: r?.followups ?? 0,
      replied: r?.replied ?? 0,
      received: r?.received ?? 0,
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
    const r = rows[0];
    return {
      user: {
        sent: r?.user_sent ?? 0,
        read: r?.user_read ?? 0,
        followUps: r?.user_followups ?? 0,
        replied: r?.user_replied ?? 0,
        received: r?.user_received ?? 0,
        conversations: r?.user_conversations ?? 0,
      },
      global: {
        sent: r?.global_sent ?? 0,
        read: r?.global_read ?? 0,
        followUps: r?.global_followups ?? 0,
        replied: r?.global_replied ?? 0,
        received: r?.global_received ?? 0,
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
}
