// src/middlewares/rateLimiter.ts
import rateLimit from "express-rate-limit";
import { AuthRequest } from "../types";
import { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX } from "../config/env";
import { createRateLimitStore } from "../config/rateLimitStore";

// Window is shared by all limiters and driven by env (minutes -> ms).
const WINDOW_MS = RATE_LIMIT_WINDOW * 60 * 1000;

/**
 * IPv6-safe rate-limit key for an IP address.
 *
 * express-rate-limit v7.5.1 (installed) does not export the `ipKeyGenerator`
 * helper, so we normalise here: an IPv4 address is used as-is, while an IPv6
 * address is collapsed to its /64 network. A single IPv6 client is typically
 * assigned a whole /64, so keying on the full address would let it rotate
 * through billions of addresses to evade the limit.
 */
const ipKey = (ip: string | undefined): string => {
  if (!ip) return "unknown";
  if (ip.includes(":")) {
    // IPv6 -> first four hextets (/64 network)
    return `${ip.split(":").slice(0, 4).join(":")}::/64`;
  }
  return ip;
};

// Shared options: emit standard RateLimit-* headers, drop legacy X-RateLimit-*.
// passOnStoreError fails OPEN if the (Redis) store errors mid-request - we allow
// the request rather than 500 or crash. Availability is preferred over strict
// enforcement during a store outage; the in-memory fallback isn't affected.
const shared = {
  windowMs: WINDOW_MS,
  standardHeaders: true as const,
  legacyHeaders: false as const,
  passOnStoreError: true,
};

/**
 * Coarse global ceiling, keyed by client IP. Mounted on every /api route as a
 * backstop against unauthenticated abuse and shared-IP (NAT) traffic.
 */
export const apiLimiter = rateLimit({
  ...shared,
  store: createRateLimitStore("rl:global:"),
  max: RATE_LIMIT_MAX,
  keyGenerator: (req) => ipKey(req.ip),
  message: "Too many requests, please try again later",
});

/**
 * Strict limiter for credential endpoints (login / register), keyed by IP.
 * Deliberately much tighter than the global ceiling to blunt brute-force and
 * credential-stuffing attempts.
 */
export const authLimiter = rateLimit({
  ...shared,
  store: createRateLimitStore("rl:auth:"),
  max: 10,
  keyGenerator: (req) => ipKey(req.ip),
  message: "Too many authentication attempts, please try again later",
});

/**
 * Limiter for the token-refresh endpoint, keyed by IP. Refresh happens roughly
 * every access-token lifetime (~15 min) per active session, so the strict
 * authLimiter would be far too tight; this is a looser abuse ceiling.
 */
export const refreshLimiter = rateLimit({
  ...shared,
  max: 60,
  keyGenerator: (req) => ipKey(req.ip),
  message: "Too many token refreshes, please slow down",
});

/**
 * Per-user limiter for authenticated HubSpot operations. Keyed by user id so
 * each account gets its own budget regardless of source IP, falling back to the
 * IP key for safety. Kept below the global ceiling so it is the effective limit
 * for a single authenticated user while the global limiter still guards shared
 * IPs. Must run AFTER `authenticate` so req.user is populated.
 */
export const userAwareLimiter = rateLimit({
  ...shared,
  store: createRateLimitStore("rl:user:"),
  max: 80,
  keyGenerator: (req: AuthRequest) => req.user?.id ?? ipKey(req.ip),
  message: "Too many requests for this user, please slow down",
});
