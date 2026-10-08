// src/services/ownerOverrideService.ts
//
// Business rules for the manual owner-override path: scope enforcement
// (who can see/resolve which ambiguous conversations), owner validation
// (must be a live HubSpot-connected owner), and orchestration of the
// repository's atomic write. See the design doc's Auth section for why
// x-requester-email is trusted fully once requirePublicApiKey has passed,
// and why there is no local admin allowlist here.
import { OwnerOverrideRepository, AmbiguousSortBy, SortOrder } from "../repositories/ownerOverrideRepository";
import { getConnectedOwnerIds, getUserIdByEmail } from "./hubspotOwnersService";
import { ValidationError, ForbiddenError } from "../errors/AppError";

export type RequesterScope = "regular" | "all";

export interface AmbiguousConversationDTO {
  conversationKey: string;
  participantName: string | null;
  resolvedAt: Date;
}

export interface AmbiguousListResult {
  data: AmbiguousConversationDTO[];
  metadata: { total: number; page: number; limit: number; totalPages: number };
}

export class OwnerOverrideService {
  // The requester's email may not correspond to any row in this service's
  // own User table (see design doc) — that's expected, not an error; it
  // just means a 'regular'-scope request from that requester can never
  // match any conversation (they've never been recorded as a scraper here).
  private static async resolveScraperUserId(requesterEmail: string): Promise<string | null> {
    return (await getUserIdByEmail(requesterEmail)) ?? null;
  }

  static async listAmbiguous(params: {
    requesterEmail: string;
    scope: RequesterScope;
    page: number;
    limit: number;
    sortBy: AmbiguousSortBy;
    sortOrder: SortOrder;
    search?: string;
  }): Promise<AmbiguousListResult> {
    let scraperUserId: string | undefined;
    if (params.scope === "regular") {
      scraperUserId = (await this.resolveScraperUserId(params.requesterEmail)) ?? undefined;
      // No matching User row for this requester — never query/leak every
      // conversation; an empty page is the correct, safe answer.
      if (!scraperUserId) {
        return { data: [], metadata: { total: 0, page: params.page, limit: params.limit, totalPages: 1 } };
      }
    }

    const { data, total } = await OwnerOverrideRepository.listAmbiguous({
      scraperUserId,
      page: params.page,
      limit: params.limit,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
      search: params.search,
    });

    return {
      data,
      metadata: {
        total,
        page: params.page,
        limit: params.limit,
        totalPages: Math.max(1, Math.ceil(total / params.limit)),
      },
    };
  }

  static async applyOverride(params: {
    conversationKey: string;
    newOwnerId: string;
    requesterEmail: string;
    scope: RequesterScope;
  }): Promise<void> {
    if (params.scope === "regular") {
      const scraperUserId = await this.resolveScraperUserId(params.requesterEmail);
      const isScraper = scraperUserId
        ? await OwnerOverrideRepository.isScraperOfConversation(params.conversationKey, scraperUserId)
        : false;
      if (!isScraper) {
        throw new ForbiddenError("Not authorized to override this conversation");
      }
    }

    const connectedIds = await getConnectedOwnerIds();
    if (!connectedIds.includes(params.newOwnerId)) {
      throw new ValidationError("ownerId must be a HubSpot-connected owner");
    }

    const cached = await OwnerOverrideRepository.findCachedOwner(params.conversationKey);
    await OwnerOverrideRepository.applyOverride({
      conversationKey: params.conversationKey,
      oldOwnerId: cached?.resolvedOwnerId ?? null,
      newOwnerId: params.newOwnerId,
      performedByEmail: params.requesterEmail,
    });
  }
}
