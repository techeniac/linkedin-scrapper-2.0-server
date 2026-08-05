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

    // Isolated from the upsert above: the extension's tracker updates its
    // change-detection signature BEFORE this network call resolves, so if
    // this whole request failed over an events-only error, the client would
    // never retry — that batch's events would be silently lost forever, even
    // though the (more important) aggregate metrics above were saved fine.
    // A failure here degrades report accuracy for one batch, not correctness.
    let eventsRecorded = 0;
    if (events?.length) {
      try {
        await MessageEventService.recordEvents(userId, {
          conversationKey: input.conversationKey,
          participantLinkedinId: input.participantLinkedinId,
          selfLinkedinId: input.selfLinkedinId,
          events,
        });
        eventsRecorded = events.length;
      } catch (eventError) {
        logger.error("[MSG][api] recordEvents failed (non-fatal)", {
          userId,
          conversationKey: input.conversationKey,
          error: eventError instanceof Error ? eventError.message : eventError,
        });
      }
    }

    logger.info("[MSG][api] POST /messages/activity", {
      userId,
      conversationKey: input.conversationKey,
      sent: input.sentCount,
      events: eventsRecorded,
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
