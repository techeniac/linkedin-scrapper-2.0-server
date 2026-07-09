// src/utils/tokens.ts
import crypto from "crypto";

/**
 * Generate a high-entropy opaque token (used for refresh tokens).
 * 32 random bytes -> 64 hex chars. The raw value is returned to the client;
 * only its SHA-256 hash is ever persisted.
 */
export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * SHA-256 hash of a token/code, hex-encoded. Deterministic so we can look a
 * token up by its hash. Suitable here because the inputs are either
 * high-entropy (refresh tokens) or short-lived + attempt-limited (reset codes).
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a cryptographically-random 6-digit numeric OTP as a string
 * (zero-padded, always 6 chars). Range 000000-999999.
 */
export function generateResetCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}
