import { Request, Response, NextFunction } from "express";
import { AuthService } from "../services/authService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { LoginRequest, RegisterRequest } from "../types";

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

export const logout = async (req: Request, res: Response): Promise<void> => {
  successResponse(res, null, "Logout successful");
};

export const getProfile = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const user = (req as any).user;
  successResponse(res, { user }, "Profile retrieved successfully");
};
