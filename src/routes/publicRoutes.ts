import { Router } from "express";
import {
  getSummary,
  getFilters,
  getConnections,
  getMessages,
  getLateMessages,
  getMissedFollowUps,
} from "../controllers/publicController";
import { requireApiKey } from "../middlewares/apiKey";
import { resolveRequesterScope } from "../middlewares/requesterScope";

// Read-only router serving global connection/message data to the external
// reporting frontend (a separate project, server-to-server only). Gated by a
// shared, revocable API key (requireApiKey) plus per-request, role-based
// data scoping resolved from trusted headers (resolveRequesterScope) — see
// docs/superpowers/specs/2026-09-22-role-scoped-reports-api-design.md.
// Still inherits the global IP `apiLimiter` from routes/index.ts.
// Do NOT add write endpoints here.
const router = Router();

router.use(requireApiKey);
router.use(resolveRequesterScope);

router.get("/summary", getSummary);
router.get("/filters", getFilters);
router.get("/connections", getConnections);
router.get("/messages", getMessages);
router.get("/late-messages", getLateMessages);
router.get("/missed-followups", getMissedFollowUps);

export default router;
