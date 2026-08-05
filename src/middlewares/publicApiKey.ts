import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { PUBLIC_API_KEY } from "../config/env";
import { UnauthorizedError } from "../errors/AppError";

/**
 * Optional shared-secret gate for the /api/public/* router.
 *
 * Those endpoints are deliberately unauthenticated so the reporting frontend can
 * read them without a login, but they expose who each user has been messaging
 * and connecting with on LinkedIn. Now that the API is deployed on a public
 * URL, that data is readable by anyone who finds the hostname.
 *
 * This middleware is OPT-IN and defaults to today's behaviour:
 *   - PUBLIC_API_KEY unset  → no change, requests pass through
 *   - PUBLIC_API_KEY set    → requests must send a matching key
 *
 * So it can be deployed safely now and switched on the moment the reporting
 * frontend is ready to send the header. The key may arrive either as
 * `x-api-key: <key>` or `Authorization: Bearer <key>`.
 *
 * This is a deployment shutter, NOT a replacement for the per-user RBAC the
 * router's own comment says is still to come: one shared key cannot express
 * which rows a given viewer is allowed to see.
 */

// Constant-time compare so a wrong key can't be recovered by timing the
// response. Length is compared first because timingSafeEqual throws on a
// length mismatch.
const matches = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const requirePublicApiKey = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  // Not configured → preserve existing open behaviour.
  if (!PUBLIC_API_KEY) return next();

  const headerKey = req.headers["x-api-key"];
  const fromHeader = Array.isArray(headerKey) ? headerKey[0] : headerKey;

  const parts = req.headers.authorization?.split(" ");
  const fromBearer =
    parts?.length === 2 && parts[0] === "Bearer" ? parts[1] : undefined;

  const provided = fromHeader || fromBearer;

  if (!provided || !matches(provided, PUBLIC_API_KEY)) {
    return next(new UnauthorizedError("Invalid or missing API key"));
  }

  next();
};
