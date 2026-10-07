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
// HubSpot owner assigned.
//
// Two genuinely different situations both currently surface as
// attributionSource 'fallback' / resolvedOwnerId null on message_events, but
// only ONE of them is a permanent fact worth caching forever in
// conversation_owner_cache:
//   - A synced contact with no HubSpot owner assigned (or no resolvable
//     LinkedIn handle to look one up with) — this IS permanent; caching it
//     is correct, and it's what short-circuits future resolveAndPersist
//     calls for that conversation.
//   - The resolver FAILING to find out — the scraper isn't HubSpot-connected,
//     or a HubSpot API call throws (rate limit, network blip) — this is
//     transient. These are marked with `transient: true` on the returned
//     ResolvedOwner and are deliberately NOT written to
//     conversation_owner_cache, so the next resolveAndPersist call for that
//     conversationKey (a new message, or a re-run of the backfill script)
//     is a cache MISS and retries the HubSpot lookup instead of being stuck
//     on 'fallback' forever. message_events rows still get stamped
//     resolvedOwnerId null / attributionSource 'fallback' in the meantime
//     (same as the permanent case) so they don't sit in limbo — only the
//     cache row is withheld.
import prisma from "../config/prisma";
import logger from "../utils/logger";
import { ConversationOwnerCacheRepository } from "../repositories/conversationOwnerCacheRepository";
import { MessageEventRepository } from "../repositories/messageEventRepository";
import { HubSpotContextService } from "./hubspotContextService";

export type AttributionSource = "hubspot" | "fallback" | "ambiguous";

export interface ResolvedOwner {
  ownerId: string | null;
  source: AttributionSource;
  // True ONLY when resolution failed to find out (HubSpot-connection or API
  // failure) rather than genuinely finding no owner — see the file header.
  // Absent/falsy for every normal result, including a real "no owner" fact.
  transient?: boolean;
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

    // Only cache a genuinely-resolved result (including a real "no owner"
    // fact) — a transient failure must NOT poison the cache, or it would
    // short-circuit every future resolution attempt for this conversation
    // forever (the cache-hit path above never re-queries HubSpot once a row
    // exists). message_events still gets stamped either way, below.
    if (!resolved.transient) {
      await ConversationOwnerCacheRepository.upsert(params.conversationKey, resolved.ownerId, resolved.source);
    }
    await MessageEventRepository.updateResolvedOwner(params.conversationKey, resolved.ownerId, resolved.source);
  }

  private static async resolveOwnerFromHubSpot(
    conversationKey: string,
    scraperUserId: string,
  ): Promise<ResolvedOwner> {
    // The name LinkedIn already gives at message-sync time — see the design
    // doc: LinkedIn's message-thread data never carries a resolvable vanity
    // handle, so the URN-based lookup this used to do always missed. A
    // missing name is a genuine, permanent "can't resolve, and never will
    // from this data" case — deliberately outside the try/catch below (no
    // HubSpot call is even attempted).
    const activity = await prisma.messageActivity.findUnique({
      where: { userId_conversationKey: { userId: scraperUserId, conversationKey } },
      select: { participantName: true },
    });
    const name = activity?.participantName?.trim();
    if (!name) return { ownerId: null, source: "ambiguous" };

    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ");

    // Only the actual HubSpot round-trip can fail transiently (scraper not
    // HubSpot-connected, rate limit, network blip) — those failures must NOT
    // be cached as a permanent fact. See file header.
    let match: { ownerId: string | null; matchCount: number };
    try {
      const { syncService } = await HubSpotContextService.getContext(scraperUserId);
      match = await syncService.findContactOwnerIdByName(firstName, lastName);
    } catch (err: any) {
      logger.warn(
        `[MessageOwnerResolver] transient resolution failure for conversation ${conversationKey}: ${err?.message}`,
      );
      return { ownerId: null, source: "fallback", transient: true };
    }

    // 0 matches, 2+ matches, or exactly 1 match with no HubSpot owner set —
    // no disambiguation signal exists in captured data for any of these.
    if (match.matchCount !== 1 || !match.ownerId) {
      return { ownerId: null, source: "ambiguous" };
    }

    const user = await prisma.user.findFirst({
      where: { hubspotOwnerId: match.ownerId },
      select: { id: true },
    });
    // A real HubSpot owner exists but isn't a connected Techeniac user — not
    // a transient failure (HubSpot answered definitively), and not a
    // resolution either. See this plan's Global Constraints ruling.
    if (!user) return { ownerId: null, source: "ambiguous" };

    return { ownerId: user.id, source: "hubspot" };
  }
}
