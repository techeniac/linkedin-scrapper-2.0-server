import prisma from "../config/prisma";
import { HubSpotOAuthService } from "./hubspotOAuthService";
import { HubSpotSyncService } from "./hubspotSyncService";

export interface HubSpotContext {
  userId: string;
  ownerId?: string;
  syncService: HubSpotSyncService;
}

export class HubSpotContextService {
  static async getContext(userId: string): Promise<HubSpotContext> {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      const err: any = new Error("HubSpot connection required");
      err.statusCode = 400;
      throw err;
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
