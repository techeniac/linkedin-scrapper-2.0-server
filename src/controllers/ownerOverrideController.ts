// src/controllers/ownerOverrideController.ts
import { Response, NextFunction } from "express";
import { RequesterRequest } from "../middlewares/requesterContext";
import { OwnerOverrideService } from "../services/ownerOverrideService";
import { ValidationError } from "../errors/AppError";
import { successResponse } from "../utils/apiResponse";

// GET /api/owner-overrides — every conversation currently needing a manual
// resolution, scoped per requireRequesterContext's x-scope rule.
export const listOwnerOverrides = async (
  req: RequesterRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data = await OwnerOverrideService.listAmbiguous({
      requesterEmail: req.requesterEmail!,
      scope: req.requesterScope!,
    });
    successResponse(res, { data }, "Ambiguous conversations retrieved");
  } catch (error) {
    next(error);
  }
};

// POST /api/owner-overrides/:conversationKey — body { ownerId }.
export const applyOwnerOverride = async (
  req: RequesterRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const conversationKey = req.params.conversationKey;
    const ownerId = typeof req.body?.ownerId === "string" ? req.body.ownerId.trim() : "";
    if (!conversationKey || !ownerId) {
      throw new ValidationError("conversationKey and ownerId are required");
    }

    await OwnerOverrideService.applyOverride({
      conversationKey,
      newOwnerId: ownerId,
      requesterEmail: req.requesterEmail!,
      scope: req.requesterScope!,
    });
    successResponse(res, { conversationKey, ownerId }, "Owner override applied");
  } catch (error) {
    next(error);
  }
};
