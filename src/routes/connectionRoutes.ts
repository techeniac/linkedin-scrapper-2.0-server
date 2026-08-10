import { Router } from "express";
import { body } from "express-validator";
import {
  trackConnection,
  updateConnectionStatus,
  reconcileConnections,
  backfillConnectionName,
  getConnectionStats,
  getConnectionStatsToday,
} from "../controllers/connectionController";
import { authenticate } from "../middlewares/auth";
import { validate } from "../middlewares/validateRequest";
import { userAwareLimiter } from "../middlewares/rateLimiter";

const router = Router();

// All connection-tracking routes require an authenticated user.
router.use(authenticate);

// POST /api/connections/track - record a sent connection request
router.post(
  "/track",
  userAwareLimiter,
  [
    body("targetLinkedinId")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("targetLinkedinId is required"),
    body("targetProfileUrl").optional().isString(),
    body("targetName").optional().isString(),
    body("actorLinkedinId").optional().isString(),
    body("actorName").optional().isString(),
    body("actorPublicIdentifier").optional().isString(),
    validate,
  ],
  trackConnection,
);

// POST /api/connections/status - reconcile a request to a new status
router.post(
  "/status",
  userAwareLimiter,
  [
    body("targetLinkedinId")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("targetLinkedinId is required"),
    body("status")
      // NOT_ACCEPTED still accepted so an older extension build doesn't start
      // failing validation; it is no longer written by anything.
      .isIn(["PENDING", "ACCEPTED", "NOT_ACCEPTED", "WITHDRAWN", "EXPIRED"])
      .withMessage("status must be a valid ConnectionRequestStatus"),
    validate,
  ],
  updateConnectionStatus,
);

// POST /api/connections/reconcile - bulk-reconcile PENDING rows from a snapshot
router.post(
  "/reconcile",
  userAwareLimiter,
  [
    body("stillPendingIds").isArray().withMessage("stillPendingIds must be an array"),
    body("stillPendingIds.*").isString(),
    body("connected").isArray({ max: 1000 }).withMessage("connected must be an array (max 1000)"),
    body("connected.*.targetLinkedinId").isString().trim().notEmpty(),
    body("connected.*.name").optional().isString(),
    body("connected.*.connectedAt").optional().isString(),
    body("sentInvitationsFetched").isBoolean(),
    // True only when the Sent-list walk reached the end. Optional so older
    // extension builds keep working — treated as false (partial) when absent,
    // which blocks any EXPIRED resolution.
    body("sentListComplete").optional().isBoolean(),
    // { nullable: true }: the client sends coverageFloor: null on purpose when
    // the connections list was FULLY fetched (see connectionSync.ts) — that's
    // the success case, not an edge case. Without nullable:true, express-
    // validator's optional() only skips undefined, not an explicit null, so
    // this rejected every fully-covered sync with "Validation failed".
    body("coverageFloor").optional({ nullable: true }).isString(),
    body("actorLinkedinId").optional().isString(),
    validate,
  ],
  reconcileConnections,
);

// POST /api/connections/backfill-name - fill a missing target name on a row
router.post(
  "/backfill-name",
  userAwareLimiter,
  [
    body("targetLinkedinId").isString().trim().notEmpty(),
    body("targetName").isString().trim().notEmpty(),
    validate,
  ],
  backfillConnectionName,
);

// GET /api/connections/stats - per-user + global metrics
router.get("/stats", userAwareLimiter, getConnectionStats);

// GET /api/connections/stats/today - the extension popup's daily counters
router.get("/stats/today", userAwareLimiter, getConnectionStatsToday);

export default router;
