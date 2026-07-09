import { authLimiter, refreshLimiter } from "../middlewares/rateLimiter";
import { Router } from "express";
import {
  register,
  login,
  logout,
  getProfile,
  refresh,
  forgotPassword,
  resetPassword,
} from "../controllers/authController";
import { body } from "express-validator";
import { validate } from "../middlewares/validateRequest";
import { authenticate } from "../middlewares/auth";

const router = Router();

// POST /api/auth/register - Register new user with validation
router.post(
  "/register",
  authLimiter,
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
  authLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
    validate,
  ],
  login,
);

// POST /api/auth/refresh - Exchange a refresh token for a new token pair
router.post(
  "/refresh",
  refreshLimiter,
  [
    body("refreshToken")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("refreshToken is required"),
    validate,
  ],
  refresh,
);

// POST /api/auth/logout - Revoke the provided refresh token (no auth required
// so it works even after the access token has expired)
router.post("/logout", logout);

// POST /api/auth/forgot-password - Send a password-reset OTP to the email
router.post(
  "/forgot-password",
  authLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    validate,
  ],
  forgotPassword,
);

// POST /api/auth/reset-password - Reset password using the emailed OTP
router.post(
  "/reset-password",
  authLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("code")
      .isString()
      .trim()
      .matches(/^\d{6}$/)
      .withMessage("code must be a 6-digit number"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    validate,
  ],
  resetPassword,
);

// GET /api/auth/profile - Get authenticated user profile
router.get("/profile", authenticate, getProfile);

export default router;
