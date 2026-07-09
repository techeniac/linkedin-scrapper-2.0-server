import { Response, NextFunction } from "express";
import { AuthService } from "../services/authService";
import { UserModel } from "../models/userModel";
import { UnauthorizedError } from "../errors/AppError";
import { AuthRequest } from "../types";

// Middleware to verify JWT token and attach user to request
export const authenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Extract token from Authorization header
    const parts = req.headers.authorization?.split(" ");
    const token = parts?.length === 2 && parts[0] === "Bearer" ? parts[1] : undefined;

    if (!token) {
      return next(new UnauthorizedError("Authentication required"));
    }

    // Verify token and get user
    const decoded = AuthService.verifyToken(token);
    const user = await UserModel.findById(decoded.userId);

    if (!user) {
      return next(new UnauthorizedError("User not found"));
    }

    // Attach user to request object
    req.user = user;
    next();
  } catch (error) {
    next(new UnauthorizedError("Invalid token"));
  }
};
