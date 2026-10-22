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

// The 5 branches inside resolveOwnerFromHubSpot that can land on
// source: "ambiguous" — see the design doc's table mapping each code to
// its originating condition. Reported, not newly introduced: every branch
// below already returned "ambiguous" before this type existed.
export type AmbiguousReason =
  | "NO_NAME"
  | "SINGLE_WORD_NAME"
  | "NO_HUBSPOT_MATCH"
  | "MULTIPLE_HUBSPOT_MATCHES"
  | "OWNER_NOT_CONNECTED";

export interface ResolvedOwner {
  ownerId: string | null;
  source: AttributionSource;
  // True ONLY when resolution failed to find out (HubSpot-connection or API
  // failure) rather than genuinely finding no owner — see the file header.
  // Absent/falsy for every normal result, including a real "no owner" fact.
  transient?: boolean;
  // Set only when source is "ambiguous" — which of the 5 codes applied.
  ambiguousReason?: AmbiguousReason;
}

// Retry policy for conversations that went ambiguous for a reason that can fix
// itself: the contact hadn't reached HubSpot yet (NO_HUBSPOT_MATCH) or its owner
// wasn't connected yet (OWNER_NOT_CONNECTED). NO_NAME / SINGLE_WORD_NAME /
// MULTIPLE_HUBSPOT_MATCHES never resolve without a human, so they are not retried.
// shortcut: lazy retry on report load (no cron on Vercel), throttled per process
// and capped per run — move to a scheduled job if the ambiguous queue grows.
const RETRYABLE_REASONS = ["NO_HUBSPOT_MATCH", "OWNER_NOT_CONNECTED"];
const RETRY_MIN_AGE_MS = 5 * 60 * 1000; // give the HubSpot sync time to land
const RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // after a day it needs a human
const RETRY_THROTTLE_MS = 10 * 60 * 1000;
const RETRY_BATCH = 20; // bounds HubSpot calls per run
let lastRetryAt = 0;
let retryInFlight: Promise<number> | null = null;

export class MessageOwnerResolverService {
  /**
   * Re-resolves recent retryable-ambiguous conversations and credits them to
   * the HubSpot owner once one is found, restamping their events. Never
   * touches 'manual' rows (see promoteAmbiguous). Returns how many resolved.
   */
  static retryAmbiguous(now: Date = new Date()): Promise<number> {
    if (retryInFlight) return retryInFlight;
    if (now.getTime() - lastRetryAt < RETRY_THROTTLE_MS) return Promise.resolve(0);
    lastRetryAt = now.getTime();
    retryInFlight = this.runRetry(now).finally(() => {
      retryInFlight = null;
    });
    return retryInFlight;
  }

  private static async runRetry(now: Date): Promise<number> {
    const rows = await ConversationOwnerCacheRepository.findRetryableAmbiguous({
      reasons: RETRYABLE_REASONS,
      olderThan: new Date(now.getTime() - RETRY_MIN_AGE_MS),
      newerThan: new Date(now.getTime() - RETRY_MAX_AGE_MS),
      limit: RETRY_BATCH,
    });
    let resolvedCount = 0;
    // Sequential on purpose: HubSpot's Search API is rate limited.
    for (const { conversationKey, scraperUserId } of rows) {
      if (!scraperUserId) continue;
      try {
        const r = await this.resolveOwnerFromHubSpot(conversationKey, scraperUserId);
        if (r.source !== "hubspot" || !r.ownerId) continue; // still ambiguous / transient
        if (await ConversationOwnerCacheRepository.promoteAmbiguous(conversationKey, r.ownerId)) {
          await MessageEventRepository.updateResolvedOwner(conversationKey, r.ownerId, "hubspot");
          resolvedCount++;
        }
      } catch (err: any) {
        logger.warn(`[MessageOwnerResolver] retry failed for ${conversationKey}: ${err?.message}`);
      }
    }
    if (resolvedCount) logger.info(`[MessageOwnerResolver] auto-resolved ${resolvedCount} ambiguous conversation(s)`);
    return resolvedCount;
  }

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
      await ConversationOwnerCacheRepository.upsert(
        params.conversationKey,
        resolved.ownerId,
        resolved.source,
        resolved.ambiguousReason,
      );
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
    // Not scoped to scraperUserId's own activity row: multiple Techeniac
    // users can scrape the same shared LinkedIn account, and only one of
    // them may have captured the participant name. Any scraper's captured
    // name for this conversationKey is usable.
    // Prefer a row a human has already corrected (participantNameOverridden)
    // over whichever scraper's row Postgres happens to return first — once a
    // correction exists for this conversationKey, it's the name that should
    // drive resolution, not a stale/raw capture from another scraper's row.
    const activity = await prisma.messageActivity.findFirst({
      where: { conversationKey, participantName: { not: null } },
      orderBy: { participantNameOverridden: "desc" },
      select: { participantName: true },
    });
    const name = activity?.participantName?.trim();
    if (!name) return { ownerId: null, source: "ambiguous", ambiguousReason: "NO_NAME" };

    const [firstName, ...rest] = name.split(" ");
    const lastName = rest.join(" ");

    // Only the actual HubSpot round-trip can fail transiently (scraper not
    // HubSpot-connected, rate limit, network blip) — those failures must NOT
    // be cached as a permanent fact. See file header. A single-word name is
    // attempted too (not skipped up front) so a disconnected scraper still
    // gets this transient/fallback protection instead of a premature
    // permanent cache write — the SINGLE_WORD_NAME check below runs only
    // once the round-trip itself has either succeeded or been ruled out.
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

    // A single-word name never had a safe HubSpot filter to narrow on (see
    // HubSpotContactService.findContactOwnerIdByName's own short-circuit,
    // which already returns matchCount 2 for this case without calling
    // HubSpot) — checked explicitly here, by the name itself rather than
    // matchCount, so it isn't conflated with a genuine MULTIPLE_HUBSPOT_MATCHES.
    if (!lastName) return { ownerId: null, source: "ambiguous", ambiguousReason: "SINGLE_WORD_NAME" };

    if (match.matchCount === 0) {
      return { ownerId: null, source: "ambiguous", ambiguousReason: "NO_HUBSPOT_MATCH" };
    }
    if (match.matchCount >= 2) {
      return { ownerId: null, source: "ambiguous", ambiguousReason: "MULTIPLE_HUBSPOT_MATCHES" };
    }
    if (!match.ownerId) {
      return { ownerId: null, source: "ambiguous", ambiguousReason: "OWNER_NOT_CONNECTED" };
    }

    const user = await prisma.user.findFirst({
      where: { hubspotOwnerId: match.ownerId },
      select: { id: true },
    });
    // A real HubSpot owner exists but isn't a connected Techeniac user — not
    // a transient failure (HubSpot answered definitively), and not a
    // resolution either. See this plan's Global Constraints ruling.
    if (!user) return { ownerId: null, source: "ambiguous", ambiguousReason: "OWNER_NOT_CONNECTED" };

    return { ownerId: user.id, source: "hubspot" };
  }
}
