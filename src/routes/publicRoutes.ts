import { Router } from "express";
import {
  getSummary,
  getFilters,
  getConnections,
  getMessages,
  getLateMessages,
  getMissedFollowUps,
  getForgottenLeads,
} from "../controllers/publicController";
import { requirePublicApiKey } from "../middlewares/publicApiKey";
import { authenticate } from "../middlewares/auth";

// Read-only router serving global connection/message data to the reporting
// frontend. Gated behind `authenticate` (same JWT/users-table auth as the
// rest of the API) plus the optional shared-secret `requirePublicApiKey`
// no-op layer. Still inherits the global IP `apiLimiter` from routes/index.ts.
// Do NOT add write endpoints here.
const router = Router();

router.use(requirePublicApiKey);
router.use(authenticate);

router.get("/summary", getSummary);
router.get("/filters", getFilters);
router.get("/connections", getConnections);
router.get("/messages", getMessages);
router.get("/late-messages", getLateMessages);
router.get("/missed-followups", getMissedFollowUps);
router.get("/forgotten-leads", getForgottenLeads);

export default router;
