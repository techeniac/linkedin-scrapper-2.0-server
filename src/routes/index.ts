import { Router } from "express";
import healthRoutes from "./healthRoutes";
import authRoutes from "./authRoutes";
import hubspotRoutes from "./hubspotRoutes";
import { apiLimiter } from "../middlewares/rateLimiter";

const router = Router();

// Apply rate limiter to all routes
router.use(apiLimiter);

// Mount route modules
router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/hubspot", hubspotRoutes);

export default router;
