import { Request, Response, NextFunction } from "express";
import { AuthService } from "../services/authService";
import { successResponse, errorResponse } from "../utils/apiResponse";
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
