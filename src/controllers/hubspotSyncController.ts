import { Response, NextFunction } from "express";
import { HubSpotSyncService } from "../services/hubspotSyncService";
import { HubSpotOAuthService } from "../services/hubspotOAuthService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import { SyncLeadRequest, CreateNoteRequest } from "../types/hubspot.types";
import prisma from "../config/prisma";
import logger from "../utils/logger";

// Sync LinkedIn lead (contact + company) to HubSpot
export const syncLead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contact, company }: SyncLeadRequest = req.body;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Check HubSpot connection via access token
    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const result = await hubspotService.syncFullLead(
      contact,
      company || null,
      user.hubspotOwnerId || undefined,
    );

    successResponse(
      res,
      { ...result, hubspotOwnerId: user.hubspotOwnerId },
      "Lead synced successfully",
    );
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

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Check HubSpot connection via access token
    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      successResponse(res, { exists: false, synced: false });
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const contact = await hubspotService.findContactByProfileUrl(
      username as string,
    );

    if (contact) {
      const name =
        [contact.firstname, contact.lastname].filter(Boolean).join(" ") ||
        undefined;
      successResponse(res, {
        exists: true,
        synced: true,
        contactId: contact.id,
        name,
        email: contact.email,
        phone: contact.phone,
        company: contact.company,
        owner: contact.owner,
        lifecycleStage: contact.lifecycleStage,
        syncedAt: contact.lastmodifieddate,
      });
      return;
    }

    successResponse(res, { exists: false, synced: false });
  } catch (error: any) {
    next(error);
  }
};

// Get HubSpot property options (owners and lifecycle stages)
export const getPropertyOptions = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const options = await hubspotService.getPropertyOptions();
    successResponse(res, options, "Property options fetched successfully");
  } catch (error: any) {
    next(error);
  }
};

// Update HubSpot contact by LinkedIn username
export const updateContact = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { username } = req.query;

    // Whitelist allowed properties
    const allowedFields = ["email", "phone", "owner", "lifecycle", "company"];
    const updates: Record<string, string> = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      errorResponse(res, "No valid fields to update", 400);
      return;
    }

    const userId = req.user!.id;
    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    await hubspotService.updateContactByUsername(username as string, updates);
    successResponse(res, null, "Contact updated successfully");
  } catch (error: any) {
    next(error);
  }
};

// Create a note associated with a HubSpot contact
export const createNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      noteTitle,
      dealValue,
      nextStep,
      notes,
      contactId,
    }: CreateNoteRequest = req.body;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const result = await hubspotService.createNote({
      noteTitle,
      dealValue,
      nextStep,
      notes,
      contactId,
      ownerId: user.hubspotOwnerId || undefined,
    });

    successResponse(res, result.id, "Note created successfully");
  } catch (error: any) {
    next(error);
  }
};

// Get all notes associated with a HubSpot contact
export const getNotes = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contactId } = req.query;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    const notes = await hubspotService.getNotesByContact(contactId as string);

    successResponse(res, notes, "Notes fetched successfully");
  } catch (error: any) {
    next(error);
  }
};

// Update an existing HubSpot note
export const updateNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { noteId } = req.params;
    const { noteTitle, dealValue, nextStep, notes } = req.body;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    await hubspotService.updateNote(noteId, {
      noteTitle,
      dealValue,
      nextStep,
      notes,
    });

    successResponse(res, null, "Note updated successfully");
  } catch (error: any) {
    next(error);
  }
};

// Delete a HubSpot note
export const deleteNote = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { noteId } = req.params;

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.hubspotAccessToken || !user?.hubspotRefreshToken) {
      errorResponse(res, "HubSpot connection required", 400);
      return;
    }

    const accessToken = await HubSpotOAuthService.getValidAccessToken(userId);
    const hubspotService = new HubSpotSyncService(accessToken);

    await hubspotService.deleteNote(noteId);

    successResponse(res, null, "Note deleted successfully");
  } catch (error: any) {
    next(error);
  }
};
