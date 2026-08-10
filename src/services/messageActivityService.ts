// src/services/messageActivityService.ts
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

  // NOTE: the report table's paginated list moved to MessageEventService.
  // list (reading message_events, not this conversation-aggregate table) —
  // see that method's doc comment for why. This class keeps only upsert and
  // the stats aggregates.
}
