// src/middlewares/rateLimiter.ts
import rateLimit from "express-rate-limit";
import { AuthRequest } from "../types";

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests, please try again later",
});

export const userAwareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  keyGenerator: (req: AuthRequest) => req.user?.id || req.ip,
  message: "Too many requests for this user, please slow down",
});
