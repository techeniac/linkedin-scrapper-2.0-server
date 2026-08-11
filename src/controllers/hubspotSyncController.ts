import { Response, NextFunction } from "express";
import { HubSpotContextService } from "../services/hubspotContextService";
import { successResponse } from "../utils/apiResponse";
import { AppError, ForbiddenError, ValidationError } from "../errors/AppError";
import { AuthRequest } from "../types";
import {
  SyncLeadRequest,
  CreateNoteRequest,
  UpsertMessagesRequest,
} from "../types/hubspot.types";
import logger from "../utils/logger";
import { getCachedContacts, setCachedContacts } from "../utils/contactsCache";

// Sync LinkedIn lead (contact + company) to HubSpot
export const syncLead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contact, company }: SyncLeadRequest = req.body;

    const { ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    // The extension sends an empty-fields placeholder ({name:"", ...}), not
    // an absent company, when a profile has no linkable LinkedIn company
    // page — that's a truthy object, so syncFullLead's own `if (company)`
    // guard wouldn't skip it. Normalize here so a nameless placeholder is
    // treated the same as no company at all, instead of attempting to
    // upsert a company with no name in HubSpot.
    const normalizedCompany = company?.name?.trim() ? company : null;

    const result = await syncService.syncFullLead(
      contact,
      normalizedCompany,
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

    const { syncService } =
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
    const { syncService } =
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
      throw new ValidationError("No valid fields to update");
    }

    const { syncService } =
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

    const { ownerId, syncService } =
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

// Get paginated notes for a specific HubSpot contact
export const getNotes = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { contactId, after } = req.query;
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);

    const { syncService } = await HubSpotContextService.getContext(req.user!.id);

    const result = await syncService.getNotesByContact(contactId as string, {
      limit,
      after: after as string | undefined,
    });

    successResponse(res, result, "Notes fetched successfully");
  } catch (error: any) {
    next(error);
  }
};

// Get all notes for contacts owned by the authenticated user (single response, no pagination)
export const getAllNotesByOwner = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { ownerId, syncService } = await HubSpotContextService.getContext(req.user!.id);

    if (!ownerId) {
      throw new AppError("HubSpot owner ID not configured for this account", 400);
    }

    let contacts = getCachedContacts(ownerId);
    if (!contacts) {
      contacts = await syncService.getAllContactsForOwner(ownerId);
      setCachedContacts(ownerId, contacts);
    }

    const notes = await syncService.getAllNotesByContacts(contacts);
    successResponse(res, { notes }, "Notes fetched successfully");
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

    const { ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    const noteOwnerId = await syncService.getNoteOwner(noteId);
    if (ownerId && noteOwnerId && noteOwnerId !== ownerId) {
      throw new ForbiddenError();
    }

    await syncService.updateNote(noteId, { noteTitle, notes });

    successResponse(res, null, "Note updated successfully");
  } catch (error: any) {
    next(error);
  }
};

// Get all contacts owned by the authenticated user (cached, for client-side search)
export const getAllContacts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { ownerId, syncService } = await HubSpotContextService.getContext(req.user!.id);

    if (!ownerId) {
      throw new AppError("HubSpot owner not configured", 400);
    }

    let contacts = getCachedContacts(ownerId);
    if (!contacts) {
      contacts = await syncService.getAllContactsForOwner(ownerId);
      setCachedContacts(ownerId, contacts);
    }

    successResponse(res, { contacts }, "Contacts fetched successfully");
  } catch (error: any) {
    next(error);
  }
};

// Get all contacts owned by the authenticated user
export const getContactsByOwner = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(200, parseInt(req.query.limit as string) || 50);
    const search = (req.query.search as string) || undefined;
    const sortBy = (req.query.sortBy as string) || "firstname";
    const sortOrder =
      (req.query.sortOrder as string)?.toUpperCase() === "DESCENDING"
        ? "DESCENDING"
        : "ASCENDING";

    const { ownerId, syncService } = await HubSpotContextService.getContext(
      req.user!.id,
    );

    if (!ownerId) {
      throw new AppError("HubSpot owner ID not configured for this account", 400);
    }

    const result = await syncService.getContactsByOwner(ownerId, {
      page,
      limit,
      search,
      sortBy,
      sortOrder,
    });

    successResponse(res, result, "Contacts fetched successfully");
  } catch (error: any) {
    next(error);
  }
};

// Get all tasks for contacts owned by the authenticated user (single response, no pagination)
export const getAllTasksByOwner = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { ownerId, syncService } = await HubSpotContextService.getContext(req.user!.id);

    if (!ownerId) {
      throw new AppError("HubSpot owner ID not configured for this account", 400);
    }

    let contacts = getCachedContacts(ownerId);
    if (!contacts) {
      contacts = await syncService.getAllContactsForOwner(ownerId);
      setCachedContacts(ownerId, contacts);
    }

    const userTimeZone = (req.query.userTimeZone as string) || "UTC";
    const tasks = await syncService.getAllTasksByContacts(contacts, userTimeZone);
    successResponse(res, { tasks }, "Tasks fetched successfully");
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

    const { ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    const noteOwnerId = await syncService.getNoteOwner(noteId);
    if (ownerId && noteOwnerId && noteOwnerId !== ownerId) {
      throw new ForbiddenError();
    }

    await syncService.deleteNote(noteId);

    successResponse(res, null, "Note deleted successfully");
  } catch (error: any) {
    next(error);
  }
};

// Upsert LinkedIn messages as HubSpot notes
export const upsertMessages = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    logger.info(`[Controller] Received upsert messages request`);

    const { conversationKey, messages, userTimeZone }: UpsertMessagesRequest =
      req.body;

    if (!conversationKey || !messages || messages.length === 0) {
      logger.error(
        `[Controller] Invalid request: missing conversationKey or messages`,
      );
      throw new ValidationError("conversationKey and messages are required");
    }

    logger.info(`[Controller] Processing ${messages.length} messages`);

    const { ownerId, syncService } =
      await HubSpotContextService.getContext(req.user!.id);

    logger.info(`[Controller] Starting message sync...`);
    const result = await syncService.upsertLinkedInMessages(
      conversationKey,
      messages,
      ownerId,
      userTimeZone,
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
