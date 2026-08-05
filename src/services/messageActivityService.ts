// src/services/messageActivityService.ts
import { Prisma } from "@prisma/client";
import { MessageActivityRepository } from "../repositories/messageActivityRepository";

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
 *
 * All Prisma/raw-SQL access lives in MessageActivityRepository — this service
 * holds only the business decisions (parsing input, which columns are
 * sortable, how to build the search/date filter).
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
  selfLinkedinIds?: string[]; // multi-select account filter; takes precedence over selfLinkedinId
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
   */
  static async upsert(
    userId: string,
    input: MessageActivityInput,
  ): Promise<void> {
    await MessageActivityRepository.upsert({
      userId,
      conversationKey: input.conversationKey,
      participantLinkedinId: input.participantLinkedinId ?? null,
      participantName: input.participantName ?? null,
      participantProfileUrl: input.participantProfileUrl ?? null,
      selfLinkedinId: input.selfLinkedinId ?? null,
      selfName: input.selfName ?? null,
      selfProfileUrl: input.selfProfileUrl ?? null,
      sentCount: input.sentCount,
      receivedCount: input.receivedCount,
      followUpCount: input.followUpCount,
      readCount: input.readCount,
      hasReply: input.hasReply,
      isConversation: input.isConversation,
      firstMessageAt: toDate(input.firstMessageAt),
      lastMessageAt: toDate(input.lastMessageAt),
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
    const r = await MessageActivityRepository.getStats(userId, restrictUserIds);
    return {
      sent: r.sent,
      read: r.read,
      followUps: r.followups,
      replied: r.replied,
      received: r.received,
      conversations: r.conversations,
    };
  }

  /** The user's stats + global totals, computed in ONE query. */
  static async getUserAndGlobalStats(
    userId: string,
  ): Promise<{ user: MessageStats; global: MessageStats }> {
    const r = await MessageActivityRepository.getUserAndGlobalStats(userId);
    return {
      user: {
        sent: r.user_sent,
        read: r.user_read,
        followUps: r.user_followups,
        replied: r.user_replied,
        received: r.user_received,
        conversations: r.user_conversations,
      },
      global: {
        sent: r.global_sent,
        read: r.global_read,
        followUps: r.global_followups,
        replied: r.global_replied,
        received: r.global_received,
        conversations: r.global_conversations,
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
    if (p.selfLinkedinIds?.length) where.selfLinkedinId = { in: p.selfLinkedinIds };
    else if (p.selfLinkedinId) where.selfLinkedinId = p.selfLinkedinId;
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

    const [data, total] = await MessageActivityRepository.findAndCount(
      where,
      { [sortBy]: sortOrder } as Prisma.MessageActivityOrderByWithRelationInput,
      (page - 1) * limit,
      limit,
    );

    return {
      data,
      metadata: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }
}
