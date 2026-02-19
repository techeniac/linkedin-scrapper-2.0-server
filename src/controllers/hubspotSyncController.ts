import { Response, NextFunction } from "express";
import { HubSpotSyncService } from "../services/hubspotSyncService";
import { HubSpotOAuthService } from "../services/hubspotOAuthService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import { SyncLeadRequest } from "../types/hubspot.types";
import prisma from "../config/prisma";

// Sync LinkedIn contact and company data to HubSpot
export const syncLead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contact, company }: SyncLeadRequest = req.body;

    // Validate required contact fields
    if (!contact || !contact.name || !contact.profileUrl) {
      errorResponse(res, "Contact with name and profileUrl required", 400);
      return;
    }

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Verify HubSpot connection
    if (!user?.hubspotOwnerId) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    // Get valid access token and sync lead
    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const result = await hubspotService.syncFullLead(
      contact,
      company || null,
      user.hubspotOwnerId,
    );

    successResponse(res, result, "Lead synced successfully");
  } catch (error: any) {
    next(error);
  }
};

// Check if LinkedIn profile exists in HubSpot
export const checkProfile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { username } = req.query;

    if (!username || typeof username !== "string") {
      errorResponse(res, "username is required", 400);
      return;
    }

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Return not synced if no HubSpot connection
    if (!user?.hubspotOwnerId) {
      successResponse(res, { exists: false, synced: false });
      return;
    }

    // Search for contact in HubSpot
    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const contact = await hubspotService.findContactByProfileUrl(username);

    if (contact) {
      const name =
        [contact.firstname, contact.lastname].filter(Boolean).join(" ") ||
        undefined;
      successResponse(res, {
        exists: true,
        synced: true,
        name,
        syncedAt: contact.lastmodifieddate,
      });
      return;
    }

    successResponse(res, { exists: false, synced: false });
  } catch (error: any) {
    next(error);
  }
};
