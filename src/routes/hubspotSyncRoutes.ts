import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { syncLead, checkProfile } from "../controllers/hubspotSyncController";

const router = Router();

router.get("/check-profile", authenticate, checkProfile);
router.post("/sync-lead", authenticate, syncLead);

export default router;
