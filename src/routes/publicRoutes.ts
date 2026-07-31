import { Router } from "express";
import {
  getSummary,
  getFilters,
  getConnections,
  getMessages,
} from "../controllers/publicController";
import { requirePublicApiKey } from "../middlewares/publicApiKey";

// PUBLIC, read-only router — intentionally NOT behind `authenticate`. Serves
// global connection/message data to the Chitragupt reporting frontend (no login
// yet; RBAC to be added later). Still inherits the global IP `apiLimiter` from
// routes/index.ts. Do NOT add write endpoints here.
//
// These responses include participant names and LinkedIn profile URLs, so on a
// public deployment they are readable by anyone who knows the hostname. The
// gate below is a no-op until PUBLIC_API_KEY is configured — set that env var
// to close the endpoints once the reporting frontend can send the header.
const router = Router();

router.use(requirePublicApiKey);

router.get("/summary", getSummary);
router.get("/filters", getFilters);
router.get("/connections", getConnections);
router.get("/messages", getMessages);

export default router;
