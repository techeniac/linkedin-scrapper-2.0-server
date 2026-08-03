import { Router } from "express";
import { body } from "express-validator";
import {
  recordMessageActivity,
  getMessageStats,
} from "../controllers/messageController";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validateRequest";
import { userAwareLimiter } from "../middlewares/rateLimiter";

const router = Router();

// All message-metric routes require an authenticated user.
router.use(authenticate);

// POST /api/messages/activity - upsert a conversation's derived metrics
router.post(
  "/activity",
  userAwareLimiter,
  [
    body("conversationKey").isString().trim().notEmpty(),
    body("participantLinkedinId").optional({ nullable: true }).isString(),
    body("participantName").optional({ nullable: true }).isString(),
    body("participantProfileUrl").optional({ nullable: true }).isString(),
    body("selfLinkedinId").optional({ nullable: true }).isString(),
    body("selfName").optional({ nullable: true }).isString(),
    body("selfProfileUrl").optional({ nullable: true }).isString(),
    body("sentCount").isInt({ min: 0 }),
    body("receivedCount").isInt({ min: 0 }),
    body("followUpCount").isInt({ min: 0 }),
    body("readCount").isInt({ min: 0 }),
    body("hasReply").isBoolean(),
    body("isConversation").isBoolean(),
    body("firstMessageAt").optional({ nullable: true }).isString(),
    body("lastMessageAt").optional({ nullable: true }).isString(),
    body("events").optional().isArray(),
    body("events.*.messageId").isString().trim().notEmpty(),
    body("events.*.type").isIn(["SENT", "RECEIVED"]),
    body("events.*.occurredAt").isString().trim().notEmpty(),
    body("events.*.isFirstTouch").optional().isBoolean(),
    body("events.*.isFollowUp").optional().isBoolean(),
    body("events.*.isFirstReply").optional().isBoolean(),
    validate,
  ],
  recordMessageActivity,
);

// GET /api/messages/stats - per-user + global messaging metrics
router.get("/stats", userAwareLimiter, getMessageStats);

export default router;
