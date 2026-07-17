import { Router } from "express";
import {
  getSummary,
  getFilters,
  getConnections,
  getMessages,
} from "../controllers/publicController";

// PUBLIC, read-only router — intentionally NOT behind `authenticate`. Serves
// global connection/message data to the Chitragupt reporting frontend (no login
// yet; RBAC to be added later). Still inherits the global IP `apiLimiter` from
// routes/index.ts. Do NOT add write endpoints here.
const router = Router();

router.get("/summary", getSummary);
router.get("/filters", getFilters);
router.get("/connections", getConnections);
router.get("/messages", getMessages);

export default router;
