// src/services/messageOwnerResolverService.ts
//
// Resolves which Techeniac User a conversation's messages should actually be
// credited to — the LinkedIn contact's HubSpot owner, reverse-mapped via
// User.hubspotOwnerId — and persists it both to the per-conversation cache
// and onto every message_events row for that conversation. See the design
// doc (docs/superpowers/specs/2026-09-01-hubspot-owner-attribution-design.md)
// for the full reasoning.
//
// Used two ways:
//   - Live: MessageEventService.recordEvents fires this in-process, non-
//     blocking, right after a batch of events is written (see that file).
//   - Backfill: src/scripts/backfillMessageOwners.ts calls this once per
//     existing conversationKey to resolve historical data the same way.
//
// Contacts are only ever messaged AFTER they're synced to HubSpot (a product
// invariant, not enforced here), so the "contact not found" case is not
// expected in practice — the only realistic miss is a synced contact with no
// HubSpot owner assigned. Both cases, and any HubSpot API failure, are
// treated identically: attributionSource 'fallback', resolvedOwnerId null,
// so reports fall back to crediting the scraper for that conversation. Not
// retried automatically (see design doc's Non-goals) — an unresolved
// conversation stays 'fallback' until its next NEW message triggers another
// resolution attempt (a fresh cache miss never happens once a row exists,
// so in practice this only self-heals if the cache row is manually cleared;
// accepted for this iteration).
import prisma from "../config/prisma";
import logger from "../utils/logger";
import { ConversationOwnerCacheRepository } from "../repositories/conversationOwnerCacheRepository";
import { MessageEventRepository } from "../repositories/messageEventRepository";
import { HubSpotContextService } from "./hubspotContextService";
import { extractLinkedInHandle } from "./hubspotHelpers";

export type AttributionSource = "hubspot" | "fallback";

export interface ResolvedOwner {
  ownerId: string | null;
  source: AttributionSource;
}

export class MessageOwnerResolverService {
  static async resolveAndPersist(params: { conversationKey: string; scraperUserId: string }): Promise<void> {
    const cached = await ConversationOwnerCacheRepository.findByConversationKey(params.conversationKey);
    if (cached) {
      await MessageEventRepository.updateResolvedOwner(
        params.conversationKey,
        cached.resolvedOwnerId,
        cached.attributionSource as AttributionSource,
      );
      return;
    }

    const resolved = await this.resolveOwnerFromHubSpot(params.conversationKey, params.scraperUserId);

    await ConversationOwnerCacheRepository.upsert(params.conversationKey, resolved.ownerId, resolved.source);
    await MessageEventRepository.updateResolvedOwner(params.conversationKey, resolved.ownerId, resolved.source);
  }

  private static async resolveOwnerFromHubSpot(
    conversationKey: string,
    scraperUserId: string,
  ): Promise<ResolvedOwner> {
    try {
      // MessageEvent only stores participantLinkedinId as LinkedIn's internal
      // "aco" id (not a usable profile handle) — MessageActivity is the only
      // place the actual profile URL is stored, keyed by the scraper who
      // recorded it.
      const activity = await prisma.messageActivity.findUnique({
        where: { userId_conversationKey: { userId: scraperUserId, conversationKey } },
        select: { participantProfileUrl: true },
      });
      const handle = extractLinkedInHandle(activity?.participantProfileUrl ?? null);
      if (!handle) return { ownerId: null, source: "fallback" };

      const { syncService } = await HubSpotContextService.getContext(scraperUserId);
      const hubspotOwnerId = await syncService.findContactOwnerIdByProfileUrl(handle);
      if (!hubspotOwnerId) return { ownerId: null, source: "fallback" };

      const user = await prisma.user.findFirst({
        where: { hubspotOwnerId },
        select: { id: true },
      });
      if (!user) return { ownerId: null, source: "fallback" };

      return { ownerId: user.id, source: "hubspot" };
    } catch (err: any) {
      logger.warn(`[MessageOwnerResolver] resolution failed for conversation ${conversationKey}: ${err?.message}`);
      return { ownerId: null, source: "fallback" };
    }
  }
}
