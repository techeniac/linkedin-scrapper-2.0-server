import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import {
  syncLead,
  checkProfile,
  getPropertyOptions,
  updateContact,
} from "../controllers/hubspotSyncController";

const router = Router();

// GET /api/hubspot/check-profile - Check if LinkedIn profile exists in HubSpot
router.get("/check-profile", authenticate, checkProfile);

// POST /api/hubspot/sync-lead - Sync LinkedIn contact and company to HubSpot
router.post("/sync-lead", authenticate, syncLead);

// GET /api/hubspot/property-options - Get HubSpot property options
router.get("/property-options", authenticate, getPropertyOptions);

// PATCH /api/hubspot/update-contact - Update contact in HubSpot
router.patch("/update-contact", authenticate, updateContact);

export default router;
