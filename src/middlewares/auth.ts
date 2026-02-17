import { Response, NextFunction } from "express";
import { AuthService } from "../services/authService";
import { UserModel } from "../models/userModel";
import { errorResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      errorResponse(res, "Authentication required", 401);
      return;
    }

    const decoded = AuthService.verifyToken(token);
    const user = await UserModel.findById(decoded.userId);

    if (!user) {
      errorResponse(res, "User not found", 401);
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    errorResponse(res, "Invalid token", 401);
  }
};
