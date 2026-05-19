import { userAwareLimiter } from "../middlewares/rateLimiter";
import { Router } from "express";
import {
  register,
  login,
  logout,
  getProfile,
} from "../controllers/authController";
import { body } from "express-validator";
import { validate } from "../middlewares/validateRequest";
import { authenticate } from "../middlewares/auth";

const router = Router();

// POST /api/auth/register - Register new user with validation
router.post(
  "/register",
  userAwareLimiter,
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters")
      .matches(/[A-Z]/)
      .withMessage("Password must contain at least one uppercase letter")
      .matches(/[0-9]/)
      .withMessage("Password must contain at least one number")
      .matches(/[^A-Za-z0-9]/)
      .withMessage("Password must contain at least one special character"),
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

export default router;
