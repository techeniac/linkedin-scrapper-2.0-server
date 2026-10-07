// src/repositories/ownerOverrideRepository.ts
//
// Data-access layer for the manual owner-override write path. See the
// design doc for the full reasoning:
// docs/superpowers/specs/2026-10-07-hubspot-owner-attribution-name-match-design.md
import prisma from "../config/prisma";

export interface AmbiguousConversation {
  conversationKey: string;
  resolvedAt: Date;
}

export class OwnerOverrideRepository {
  /**
   * Every conversation currently cached as 'ambiguous'. When scraperUserId
   * is given, narrowed to conversations where that scraper recorded at
   * least one message_events row for the conversation — the shared-
   * LinkedIn-account reality that any scraper who touched a conversation can
   * resolve it (see the design doc's GET /api/owner-overrides scope rule).
   */
  static async listAmbiguous(scraperUserId?: string): Promise<AmbiguousConversation[]> {
    if (scraperUserId) {
      return prisma.$queryRaw<AmbiguousConversation[]>`
        SELECT c.conversation_key AS "conversationKey", c.resolved_at AS "resolvedAt"
        FROM conversation_owner_cache c
        WHERE c.attribution_source = 'ambiguous'
          AND EXISTS (
            SELECT 1 FROM message_events m
            WHERE m.conversation_key = c.conversation_key AND m.user_id = ${scraperUserId}
          )
        ORDER BY c.resolved_at DESC
      `;
    }
    return prisma.$queryRaw<AmbiguousConversation[]>`
      SELECT conversation_key AS "conversationKey", resolved_at AS "resolvedAt"
      FROM conversation_owner_cache
      WHERE attribution_source = 'ambiguous'
      ORDER BY resolved_at DESC
    `;
  }

  /** Participant display name for a batch of conversationKeys, best-effort
   * (null if no message_activity row has ever captured one) — so a human
   * resolving the needs-resolution list can identify who they're picking an
   * owner for. */
  static async findParticipantNames(conversationKeys: string[]): Promise<Map<string, string | null>> {
    if (conversationKeys.length === 0) return new Map();
    const activities = await prisma.messageActivity.findMany({
      where: { conversationKey: { in: conversationKeys } },
      select: { conversationKey: true, participantName: true },
    });
    const nameByKey = new Map<string, string | null>();
    for (const a of activities) {
      if (!nameByKey.has(a.conversationKey) || (!nameByKey.get(a.conversationKey) && a.participantName)) {
        nameByKey.set(a.conversationKey, a.participantName);
      }
    }
    return nameByKey;
  }

  static async findCachedOwner(conversationKey: string): Promise<{ resolvedOwnerId: string | null } | null> {
    return prisma.conversationOwnerCache.findUnique({
      where: { conversationKey },
      select: { resolvedOwnerId: true },
    });
  }

  static async isScraperOfConversation(conversationKey: string, scraperUserId: string): Promise<boolean> {
    const row = await prisma.messageEvent.findFirst({
      where: { conversationKey, userId: scraperUserId },
      select: { conversationKey: true },
    });
    return row !== null;
  }

  /**
   * Applies a manual owner override atomically: upserts the cache row to
   * 'manual', re-stamps EVERY message_events row for this conversation (its
   * full history, not just new rows — see design doc Goal 3), and inserts an
   * audit row — all in one transaction so a crash mid-write can never leave
   * the cache, the event rows, and the audit trail disagreeing.
   */
  static async applyOverride(params: {
    conversationKey: string;
    oldOwnerId: string | null;
    newOwnerId: string;
    performedByEmail: string;
  }): Promise<void> {
    const { conversationKey, oldOwnerId, newOwnerId, performedByEmail } = params;
    await prisma.$transaction([
      prisma.conversationOwnerCache.upsert({
        where: { conversationKey },
        create: { conversationKey, resolvedOwnerId: newOwnerId, attributionSource: "manual" },
        update: { resolvedOwnerId: newOwnerId, attributionSource: "manual", resolvedAt: new Date() },
      }),
      prisma.messageEvent.updateMany({
        where: { conversationKey },
        data: { resolvedOwnerId: newOwnerId, attributionSource: "manual" },
      }),
      prisma.ownerOverrideAudit.create({
        data: { conversationKey, oldOwnerId, newOwnerId, performedByEmail },
      }),
    ]);
  }
}
