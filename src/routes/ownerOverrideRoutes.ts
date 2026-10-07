// src/routes/ownerOverrideRoutes.ts
//
// Write-capable router for the manual owner-override path — deliberately
// NOT publicRoutes.ts (its "no write endpoints" comment stays true for that
// file). requireApiKey gates it exactly as it gates the public reads
// (this is the API-key middleware requesterContext.ts's comments refer to
// as "requirePublicApiKey" — same middleware, current export name);
// requireRequesterContext MUST run after it, not before, so a request
// missing/failing the API key is rejected before either header is read.
import { Router } from "express";
import { requireApiKey } from "../middlewares/apiKey";
import { requireRequesterContext } from "../middlewares/requesterContext";
import { overrideWriteLimiter } from "../middlewares/rateLimiter";
import { listOwnerOverrides, applyOwnerOverride } from "../controllers/ownerOverrideController";

const router = Router();

router.use(requireApiKey);
router.use(requireRequesterContext);

router.get("/", listOwnerOverrides);
router.post("/:conversationKey", overrideWriteLimiter, applyOwnerOverride);

export default router;
