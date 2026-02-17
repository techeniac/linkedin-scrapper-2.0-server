import { Router } from "express";
import healthRoutes from "./healthRoutes";
import authRoutes from "./authRoutes";
import rateLimit from "express-rate-limit";
import { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX } from "../config/env";

const router = Router();

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW * 60 * 1000,
  max: RATE_LIMIT_MAX,
  message: "Too many requests, please try again later",
});

router.use(limiter);
router.use("/health", healthRoutes);
router.use("/auth", authRoutes);

export default router;
