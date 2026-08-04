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

// How long after a token is rotated a repeat presentation of it is treated as
// a benign race rather than theft. The client (browser extension) runs one
// content-script instance per open LinkedIn tab, plus a background worker and
// a popup, none of which coordinate with each other — if two of those
// contexts both notice an expired access token around the same moment, both
// can read the SAME stored refresh token and both call /auth/refresh within
// milliseconds of one another. Without this window, the second caller would
// always present an already-rotated token and get treated as a thief,
// revoking every session for that user over a race that wasn't an attack.
// A real attacker replaying a stolen token long after rotation (well outside
// this window) is still caught by the theft branch below.
const REUSE_GRACE_PERIOD_MS = Number(process.env.REFRESH_REUSE_GRACE_MS) || 10_000;

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
   * revoked token OUTSIDE the grace period is treated as theft: every refresh
   * token for that user is revoked and the request is rejected. Reuse WITHIN
   * the grace period is treated as a benign multi-tab/multi-context race (see
   * REUSE_GRACE_PERIOD_MS) — the caller gets its own fresh token instead.
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

    if (record.revokedAt) {
      const msSinceRevoked = Date.now() - record.revokedAt.getTime();
      if (msSinceRevoked <= REUSE_GRACE_PERIOD_MS) {
        // Another concurrent caller (a different tab/context) already rotated
        // this exact token moments ago — treat as a race, not theft. Issue
        // THIS caller its own fresh token rather than punishing it for
        // something it had no way to avoid.
        logger.info("Refresh token reused within grace period; treating as benign race, not theft", {
          userId: record.userId,
          msSinceRevoked,
        });
        const raced = generateOpaqueToken();
        await prisma.refreshToken.create({
          data: {
            tokenHash: hashToken(raced),
            userId: record.userId,
            expiresAt: this.expiryDate(),
          },
        });
        return { userId: record.userId, refreshToken: raced };
      }

      // Reuse detection: a revoked token being presented again, well after it
      // was rotated, means it may have been stolen. Revoke the whole family.
      logger.warn("Refresh token reuse detected outside grace period; revoking all user sessions", {
        userId: record.userId,
        msSinceRevoked,
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
