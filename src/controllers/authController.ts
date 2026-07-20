import { Request, Response, NextFunction } from "express";
import { AuthService } from "../services/authService";
import { successResponse } from "../utils/apiResponse";
import { LoginRequest, RegisterRequest } from "../types";

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

// Exchange a refresh token for a new access + refresh token pair
export const refresh = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { refreshToken } = req.body as { refreshToken: string };
    const result = await AuthService.refresh(refreshToken);
    successResponse(res, result, "Token refreshed");
  } catch (error: any) {
    next(error);
  }
};

// Logout: revoke the provided refresh token (client also drops its tokens)
export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await AuthService.logout(req.body?.refreshToken);
    successResponse(res, null, "Logout successful");
  } catch (error: any) {
    next(error);
  }
};

// Request a password-reset OTP (always succeeds to avoid account enumeration)
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email } = req.body as { email: string };
    await AuthService.requestPasswordReset(email);
    successResponse(res, null, "A reset code has been sent to your email.");
  } catch (error: any) {
    next(error);
  }
};

// Reset a password using the emailed OTP
export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email, code, password } = req.body as {
      email: string;
      code: string;
      password: string;
    };
    await AuthService.resetPassword(email, code, password);
    successResponse(res, null, "Password has been reset. Please log in.");
  } catch (error: any) {
    next(error);
  }
};

// Get authenticated user profile
export const getProfile = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const user = (req as any).user;
  successResponse(res, { user }, "Profile retrieved successfully");
};
