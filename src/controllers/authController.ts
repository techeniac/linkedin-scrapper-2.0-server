import { Request, Response, NextFunction } from "express";
import { AuthService } from "../services/authService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { LoginRequest, RegisterRequest } from "../types";
import { AppError } from "../errors/AppError";

// Register a new user
export const register = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data: RegisterRequest = req.body;
    const result = await AuthService.register(data);
    successResponse(res, result, "User registered successfully", 201);
  } catch (error: any) {
    next(error);
  }
};

// Authenticate user and return JWT token
export const login = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const data: LoginRequest = req.body;
    const result = await AuthService.login(data);
    successResponse(res, result, "Login successful");
  } catch (error: any) {
    next(error);
  }
};

// Logout user (client-side token removal)
export const logout = async (req: Request, res: Response): Promise<void> => {
  successResponse(res, null, "Logout successful");
};

// Get authenticated user profile
export const getProfile = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const user = (req as any).user;
  successResponse(res, { user }, "Profile retrieved successfully");
};

// Initiate forgot-password flow — always returns 200 to avoid email enumeration
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email } = req.body as { email: string };
    // AuthService.forgotPassword swallows SMTP errors and silently no-ops on
    // unknown emails, so we always respond with the same 200 message.
    await AuthService.forgotPassword(email);
    successResponse(
      res,
      null,
      "If that email address is registered you will receive a reset link shortly.",
    );
  } catch (error: any) {
    next(error);
  }
};

// Complete password reset using the signed JWT from the email link
export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { token, password } = req.body as { token: string; password: string };
    await AuthService.resetPassword(token, password);
    successResponse(res, null, "Password has been reset successfully. Please log in with your new password.");
  } catch (error: any) {
    // Surface operational errors (expired token, invalid token) as 400
    if (
      error.message?.includes("expired") ||
      error.message?.includes("Invalid") ||
      error.message?.includes("already-used")
    ) {
      next(new AppError(error.message, 400));
    } else {
      next(error);
    }
  }
};
