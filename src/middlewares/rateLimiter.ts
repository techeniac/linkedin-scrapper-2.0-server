// src/middlewares/rateLimiter.ts
import rateLimit from "express-rate-limit";
import { AuthRequest } from "../types";
import { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX } from "../config/env";

export const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW * 60 * 1000,
  max: RATE_LIMIT_MAX,
  message: "Too many requests, please try again later",
});

export const userAwareLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW * 60 * 1000,
  max: RATE_LIMIT_MAX * 2,
  keyGenerator: (req: AuthRequest) => req.user?.id || req.ip || "unknown",
  message: "Too many requests for this user, please slow down",
});
