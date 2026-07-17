import { Router } from "express";
import healthRoutes from "./healthRoutes";
import authRoutes from "./authRoutes";
import hubspotRoutes from "./hubspotRoutes";
import connectionRoutes from "./connectionRoutes";
import messageRoutes from "./messageRoutes";
import publicRoutes from "./publicRoutes";
import { apiLimiter } from "../middlewares/rateLimiter";

const router = Router();

// Apply rate limiter to all routes
router.use(apiLimiter);

// Mount route modules
router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/hubspot", hubspotRoutes);
router.use("/connections", connectionRoutes);
router.use("/messages", messageRoutes);
// Public, unauthenticated read-only endpoints for the reporting frontend.
router.use("/public", publicRoutes);

export default router;
