// src/middlewares/requesterContext.ts
//
// Reads x-requester-email / x-scope off a request that has already cleared
// requirePublicApiKey, and trusts them fully — no second local admin
// allowlist. See the design doc's Auth section: the shared API key IS the
// real trust boundary (only the calling service holds it); a local
// admin-email list would just be a second source of truth to keep in sync.
// Mount AFTER requirePublicApiKey on every router that uses this.
import { Request, Response, NextFunction } from "express";
import { ValidationError } from "../errors/AppError";

export type RequesterScope = "regular" | "all";

export interface RequesterRequest extends Request {
  requesterEmail?: string;
  requesterScope?: RequesterScope;
}

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export const requireRequesterContext = (
  req: RequesterRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const email = firstHeader(req.headers["x-requester-email"])?.trim();
  if (!email) {
    return next(new ValidationError("Missing x-requester-email header"));
  }

  const scopeRaw = firstHeader(req.headers["x-scope"]);
  req.requesterEmail = email;
  req.requesterScope = scopeRaw === "all" ? "all" : "regular";
  next();
};
