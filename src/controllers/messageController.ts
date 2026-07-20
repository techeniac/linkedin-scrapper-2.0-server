import { Response, NextFunction } from "express";
import {
  MessageActivityService,
  MessageActivityInput,
} from "../services/messageActivityService";
import { successResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import logger from "../utils/logger";

// POST /api/messages/activity — upsert a conversation's derived messaging metrics
export const recordMessageActivity = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const input = req.body as MessageActivityInput;
    await MessageActivityService.upsert(userId, input);
    logger.info("[MSG][api] POST /messages/activity", {
      userId,
      conversationKey: input.conversationKey,
      sent: input.sentCount,
    });
    successResponse(res, null, "Message activity recorded", 201);
  } catch (error: any) {
    next(error);
  }
};

// GET /api/messages/stats — per-user + global messaging metrics
export const getMessageStats = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const stats = await MessageActivityService.getUserAndGlobalStats(userId);
    successResponse(res, stats, "Message stats retrieved");
  } catch (error: any) {
    next(error);
  }
};
