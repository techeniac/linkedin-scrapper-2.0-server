import prisma from "../config/prisma";
import { HubSpotOAuthService } from "./hubspotOAuthService";
import { HubSpotSyncService } from "./hubspotSyncService";
import { AppError } from "../errors/AppError";

// Context object for HubSpot sync operations
export interface HubSpotContext {
  userId: string;
  ownerId?: string;
  syncService: HubSpotSyncService;
}

// Service to build HubSpot context for authenticated users
export class HubSpotContextService {
  // Get HubSpot context for user and ensure connection is configured
  static async getContext(userId: string): Promise<HubSpotContext> {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      throw new AppError("HubSpot connection required", 400);
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const syncService = new HubSpotSyncService(accessToken);

    return {
      userId,
      ownerId: user.hubspotOwnerId || undefined,
      syncService,
    };
  }
}
