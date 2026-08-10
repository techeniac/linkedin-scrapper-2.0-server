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

const toDate = (v: unknown): Date | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
};

// GET /api/messages/stats/today — the extension popup's daily counters:
// fresh/followups/sent/received/replied for the CALLER's local day only
// (from/to query params — computed client-side as local-midnight-to-now in
// UTC ISO, same pattern as the report dashboard's toUtcStartOfDayIso/
// toUtcEndOfDayIso). Reads message_events (the per-message log), NOT
// message_activity's lifetime conversation aggregates — those have no
// per-day breakdown at all, which is exactly why the old /stats endpoint
// could never show "today". Same distinct-conversation-per-day counting the
// Messages report uses, so this always agrees with what the dashboard would
// show for today's window.
export const getMessageStatsToday = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const now = new Date();
    const to = toDate(req.query.to) ?? now;
    const from = toDate(req.query.from) ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const stats = await MessageEventService.getTotals(from, to, { userId });
    successResponse(res, stats, "Today's message stats retrieved");
  } catch (error: any) {
    next(error);
  }
};
