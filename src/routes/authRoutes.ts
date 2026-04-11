import { userAwareLimiter } from "../middlewares/rateLimiter";
import { Router } from "express";
import {
  register,
  login,
  logout,
  getProfile,
  forgotPassword,
  resetPassword,
} from "../controllers/authController";
import { body } from "express-validator";
import { validate } from "../middlewares/validateRequest";
import { authenticate } from "../middlewares/auth";
import rateLimit from "express-rate-limit";

// Dedicated rate limiter for the forgot-password endpoint: 5 requests per 15 min.
// Keyed by IP to block enumeration attacks even from unauthenticated callers.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.ip ?? "unknown",
  message: "Too many password-reset requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

// POST /api/auth/register - Register new user with validation
router.post(
  "/register",
  userAwareLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("name").optional().isString(),
    validate,
  ],
  register,
);

// POST /api/auth/login - Authenticate user and return JWT
router.post(
  "/login",
  userAwareLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
    validate,
  ],
  login,
);

// POST /api/auth/logout - Logout user (requires authentication)
router.post("/logout", authenticate, logout);

// GET /api/auth/profile - Get authenticated user profile
router.get("/profile", authenticate, getProfile);

// POST /api/auth/forgot-password - Initiate password reset (rate-limited, no email enumeration)
router.post(
  "/forgot-password",
  forgotPasswordLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    validate,
  ],
  forgotPassword,
);

// POST /api/auth/reset-password - Complete password reset using the signed JWT
router.post(
  "/reset-password",
  userAwareLimiter,
  [
    body("token").notEmpty().withMessage("Reset token is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    validate,
  ],
  resetPassword,
);

export default router;
