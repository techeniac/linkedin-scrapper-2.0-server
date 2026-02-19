import { Router } from "express";
import { getHealth } from "../controllers/healthController";

const router = Router();

// GET /api/health - Health check endpoint
router.get("/", getHealth);

export default router;
