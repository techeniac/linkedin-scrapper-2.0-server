import { Response, NextFunction } from "express";
import { AuthService } from "../services/authService";
import { UserModel } from "../models/userModel";
import { UnauthorizedError } from "../errors/AppError";
import { AuthRequest } from "../types";

// Middleware to verify JWT token and attach user to request.
//
// JWT verification failures (bad signature, malformed, expired) and "DB blew
// up while looking up the user" are NOT the same thing and must not produce
// the same response. A transient DB error (e.g. connection-pool exhaustion)
// during the lookup is unrelated to whether the token is valid — reporting it
// as 401 "Invalid token" tells the client to wipe the session and force a
// logout for a problem that had nothing to do with the token, and will very
// likely have cleared up by the next request.
export const authenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  // Extract token from Authorization header
  const parts = req.headers.authorization?.split(" ");
  const token = parts?.length === 2 && parts[0] === "Bearer" ? parts[1] : undefined;

  if (!token) {
    return next(new UnauthorizedError("Authentication required"));
  }

  let decoded: { userId: string };
  try {
    decoded = AuthService.verifyToken(token);
  } catch {
    // Only a genuine JWT problem (bad signature, malformed, expired) lands
    // here — this is the one case that should actually tell the client the
    // token itself is bad.
    return next(new UnauthorizedError("Invalid token"));
  }

  try {
    const user = await UserModel.findById(decoded.userId);
    if (!user) {
      return next(new UnauthorizedError("User not found"));
    }
    // Attach user to request object
    req.user = user;
    next();
  } catch (error) {
    // NOT an auth failure — propagate as-is so the error handler reports it
    // as a 500 (or whatever it actually is), not a fake "invalid token".
    next(error);
  }
};
