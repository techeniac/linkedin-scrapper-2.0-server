import { Response, NextFunction } from "express";
import {
  MessageActivityService,
  MessageActivityInput,
} from "../services/messageActivityService";
import {
  MessageEventService,
  MessageEventInput,
} from "../services/messageEventService";
import { successResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import logger from "../utils/logger";

// POST /api/messages/activity — upsert a conversation's derived messaging
// metrics, and record this batch's per-message events (idempotent — most of
// a re-derived conversation's events already exist).
export const recordMessageActivity = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { events, ...rest } = req.body as MessageActivityInput & {
      events?: MessageEventInput[];
    };
    const input = rest as MessageActivityInput;
    await MessageActivityService.upsert(userId, input);
    if (events?.length) {
      await MessageEventService.recordEvents(userId, {
        conversationKey: input.conversationKey,
        participantLinkedinId: input.participantLinkedinId,
        selfLinkedinId: input.selfLinkedinId,
        events,
      });
    }
    logger.info("[MSG][api] POST /messages/activity", {
      userId,
      conversationKey: input.conversationKey,
      sent: input.sentCount,
      events: events?.length ?? 0,
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
