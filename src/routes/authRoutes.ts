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
