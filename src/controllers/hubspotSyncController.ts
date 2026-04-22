import { Response, NextFunction } from "express";
import { HubSpotContextService } from "../services/hubspotContextService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import {
  SyncLeadRequest,
  CreateNoteRequest,
  UpsertMessagesRequest,
} from "../types/hubspot.types";
import logger from "../utils/logger";

// Sync LinkedIn lead (contact + company) to HubSpot
export const syncLead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contact, company }: SyncLeadRequest = req.body;

    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    const result = await syncService.syncFullLead(
      contact,
      company || null,
      ownerId,
    );

    successResponse(
      res,
      { ...result, hubspotOwnerId: ownerId },
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

    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    const contact = await syncService.findContactByProfileUrl(
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
        leadStatus: contact.leadStatus,
        leadSource: contact.leadSource,
        connectedOnSource: contact.connectedOnSource,
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
    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    const options = await syncService.getPropertyOptions();
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
    const allowedFields = [
      "name",
      "email",
      "phone",
      "owner",
      "lifecycle",
      "company",
      "leadStatus",
      "leadSource",
      "connectedOnSource",
    ];

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

    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    await syncService.updateContactByUsername(username as string, updates);
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
    const { noteTitle, notes, contactId }: CreateNoteRequest = req.body;

    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    const result = await syncService.createNote({
      noteTitle,
      notes,
      contactId,
      ownerId: ownerId,
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

    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    const notes = await syncService.getNotesByContact(contactId as string);

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
    const { noteTitle, notes } = req.body;

    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    await syncService.updateNote(noteId, {
      noteTitle,
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

    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    await syncService.deleteNote(noteId);

    successResponse(res, null, "Note deleted successfully");
  } catch (error: any) {
    next(error);
  }
};

// Update the upsertMessages controller in hubspotSyncController.ts
export const upsertMessages = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    logger.info(`[Controller] Received upsert messages request`);
    logger.debug(
      `[Controller] Request body: ${JSON.stringify(req.body, null, 2)}`,
    );

    const { conversationKey, messages }: UpsertMessagesRequest = req.body;

    if (!conversationKey || !messages || messages.length === 0) {
      logger.error(
        `[Controller] Invalid request: missing conversationKey or messages`,
      );
      errorResponse(res, "conversationKey and messages are required", 400);
      return;
    }

    logger.info(`[Controller] Processing ${messages.length} messages`);

    const { userId, ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    logger.info(`[Controller] Starting message sync...`);
    const result = await syncService.upsertLinkedInMessages(
      conversationKey,
      messages,
      ownerId,
    );

    logger.info(
      `[Controller] Sync completed. Synced: ${result.synced}, Skipped: ${result.skipped}`,
    );

    successResponse(
      res,
      result,
      `Messages synced successfully. ${result.synced} created, ${result.skipped} skipped.`,
    );
  } catch (error: any) {
    logger.error(`[Controller] Message sync failed: ${error.message}`);
    next(error);
  }
};
