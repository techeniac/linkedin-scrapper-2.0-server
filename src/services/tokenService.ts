// src/services/tokenService.ts
import prisma from "../config/prisma";
import { REFRESH_TOKEN_TTL_DAYS } from "../config/env";
import { UnauthorizedError } from "../errors/AppError";
import { generateOpaqueToken, hashToken } from "../utils/tokens";
import logger from "../utils/logger";

/**
 * Refresh-token lifecycle: issue, rotate (with reuse detection), and revoke.
 * Only SHA-256 hashes of the opaque tokens are stored in the database.
 */
export class TokenService {
  private static expiryDate(): Date {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  }

  /** Issue a new refresh token for a user; returns the raw (unhashed) token. */
  static async issueRefreshToken(userId: string): Promise<string> {
    const raw = generateOpaqueToken();
    await prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(raw),
        userId,
        expiresAt: this.expiryDate(),
      },
    });
    return raw;
  }

  /**
   * Validate and rotate a refresh token. On success, the presented token is
   * revoked and a brand-new one is issued (rotation). Reuse of an already
   * revoked token is treated as theft: every refresh token for that user is
   * revoked and the request is rejected.
   */
  static async rotateRefreshToken(
    rawToken: string,
  ): Promise<{ userId: string; refreshToken: string }> {
    const record = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });

    if (!record) {
      throw new UnauthorizedError("Invalid refresh token");
    }

    // Reuse detection: a revoked token being presented again means it may have
    // been stolen. Revoke the whole family to force re-authentication.
    if (record.revokedAt) {
      logger.warn("Refresh token reuse detected; revoking all user sessions", {
        userId: record.userId,
      });
      await this.revokeAllForUser(record.userId);
      throw new UnauthorizedError("Refresh token has been revoked");
    }

    if (record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError("Refresh token has expired");
    }

    // Rotate: revoke the current token and mint a new one atomically.
    const raw = generateOpaqueToken();
    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: record.id },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          tokenHash: hashToken(raw),
          userId: record.userId,
          expiresAt: this.expiryDate(),
        },
      }),
    ]);

    return { userId: record.userId, refreshToken: raw };
  }

  /** Revoke a single refresh token (logout). Idempotent; never throws. */
  static async revokeRefreshToken(rawToken: string): Promise<void> {
    try {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(rawToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch (err: any) {
      logger.warn("Failed to revoke refresh token", { error: err?.message });
    }
  }

  /** Revoke every active refresh token for a user (password reset / theft). */
  static async revokeAllForUser(userId: string): Promise<void> {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
