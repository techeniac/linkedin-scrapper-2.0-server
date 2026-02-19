import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { syncLead, checkProfile } from "../controllers/hubspotSyncController";

const router = Router();

// GET /api/hubspot/check-profile - Check if LinkedIn profile exists in HubSpot
router.get("/check-profile", authenticate, checkProfile);

// POST /api/hubspot/sync-lead - Sync LinkedIn contact and company to HubSpot
router.post("/sync-lead", authenticate, syncLead);

export default router;
