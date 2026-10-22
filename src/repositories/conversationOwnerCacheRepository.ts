// src/repositories/conversationOwnerCacheRepository.ts
//
// Data-access layer for conversation_owner_cache. See the model comment in
// schema.prisma for why this exists (avoid a HubSpot API call per message —
// resolve a conversation's owner once, reuse it for every future message in
// that conversation).
import prisma from "../config/prisma";

export interface ConversationOwnerCacheEntry {
  conversationKey: string;
  resolvedOwnerId: string | null;
  attributionSource: string;
}

export class ConversationOwnerCacheRepository {
  static findByConversationKey(conversationKey: string): Promise<ConversationOwnerCacheEntry | null> {
    return prisma.conversationOwnerCache.findUnique({
      where: { conversationKey },
      select: { conversationKey: true, resolvedOwnerId: true, attributionSource: true },
    });
  }

  static async upsert(
    conversationKey: string,
    resolvedOwnerId: string | null,
    attributionSource: "hubspot" | "fallback" | "ambiguous" | "manual",
    ambiguousReason?: string,
  ): Promise<void> {
    // NULL whenever the source isn't 'ambiguous' — covers both the normal
    // hubspot/fallback resolver outcomes AND the override path (Task 4),
    // which calls this with attributionSource: "manual" and no reason arg.
    const reason = attributionSource === "ambiguous" ? ambiguousReason ?? null : null;
    await prisma.conversationOwnerCache.upsert({
      where: { conversationKey },
      create: { conversationKey, resolvedOwnerId, attributionSource, ambiguousReason: reason },
      update: { resolvedOwnerId, attributionSource, ambiguousReason: reason, resolvedAt: new Date() },
    });
  }

  /**
   * Ambiguous conversations whose cause can resolve on its own (e.g. the
   * contact reached HubSpot after the first message), newest first, with the
   * scraper who last touched each — the HubSpot lookup needs that scraper's
   * token. `resolved_at` is when it went ambiguous, so the window bounds how
   * long a conversation keeps being retried.
   */
  static findRetryableAmbiguous(p: {
    reasons: string[];
    olderThan: Date;
    newerThan: Date;
    limit: number;
  }): Promise<Array<{ conversationKey: string; scraperUserId: string | null }>> {
    return prisma.$queryRaw`
      SELECT c.conversation_key AS "conversationKey",
             (SELECT m.user_id FROM message_events m
               WHERE m.conversation_key = c.conversation_key
               ORDER BY m.occurred_at DESC LIMIT 1) AS "scraperUserId"
      FROM conversation_owner_cache c
      WHERE c.attribution_source = 'ambiguous'
        AND c.ambiguous_reason = ANY(${p.reasons})
        AND c.resolved_at < ${p.olderThan} AND c.resolved_at > ${p.newerThan}
      ORDER BY c.resolved_at DESC
      LIMIT ${p.limit}
    `;
  }

  /**
   * ambiguous -> hubspot, only if it is STILL ambiguous. The guard is what
   * keeps a concurrent manual override (attribution_source 'manual') from
   * ever being overwritten by an automatic retry. Returns whether it flipped.
   */
  static async promoteAmbiguous(conversationKey: string, ownerId: string): Promise<boolean> {
    const n = await prisma.$executeRaw`
      UPDATE conversation_owner_cache
      SET resolved_owner_id = ${ownerId}, attribution_source = 'hubspot',
          ambiguous_reason = NULL, resolved_at = NOW()
      WHERE conversation_key = ${conversationKey} AND attribution_source = 'ambiguous'
    `;
    return n > 0;
  }

  /** Ambiguous conversations (hidden from every report) last touched by any of these scrapers. */
  static async countAmbiguousForScrapers(scraperUserIds: string[]): Promise<number> {
    if (scraperUserIds.length === 0) return 0;
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM conversation_owner_cache c
      WHERE c.attribution_source = 'ambiguous'
        AND EXISTS (SELECT 1 FROM message_events m
                    WHERE m.conversation_key = c.conversation_key
                      AND m.user_id = ANY(${scraperUserIds}))
    `;
    return rows[0]?.count ?? 0;
  }
}
