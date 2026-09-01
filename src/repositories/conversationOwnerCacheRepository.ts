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
    attributionSource: "hubspot" | "fallback",
  ): Promise<void> {
    await prisma.conversationOwnerCache.upsert({
      where: { conversationKey },
      create: { conversationKey, resolvedOwnerId, attributionSource },
      update: { resolvedOwnerId, attributionSource, resolvedAt: new Date() },
    });
  }
}
