import { Response, NextFunction } from "express";
import { hashApiKey } from "../utils/apiKeyTokens";
import prisma from "../config/prisma";
import { UnauthorizedError } from "../errors/AppError";
import { PublicApiRequest } from "../types";
import logger from "../utils/logger";

// Trusted-caller gate for the /api/public/* router. Replaces the old
// static-env-var requirePublicApiKey (single shared secret, no revocation).
// Looks up the SHA-256 hash of `x-api-key` against the ApiKey table — same
// hashed-lookup pattern as TokenService's refresh tokens. Never distinguishes
// "revoked"/"expired"/"never existed" in the response (see spec's Error
// handling section) — all three produce the same generic 401.
export const requireApiKey = async (
  req: PublicApiRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const headerKey = req.headers["x-api-key"];
  const provided = Array.isArray(headerKey) ? headerKey[0] : headerKey;

  if (!provided) {
    return next(new UnauthorizedError("Invalid or missing API key"));
  }

  try {
    const record = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(provided) },
    });

    const expired = !!record?.expiresAt && record.expiresAt.getTime() < Date.now();
    if (!record || record.revokedAt || expired) {
      return next(new UnauthorizedError("Invalid or missing API key"));
    }

    req.apiKeyId = record.id;

    // Fire-and-forget — never blocks the request on a write.
    prisma.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch((err: any) =>
        logger.warn("Failed to update apiKey lastUsedAt", { error: err?.message }),
      );

    next();
  } catch (error) {
    next(error);
  }
};
