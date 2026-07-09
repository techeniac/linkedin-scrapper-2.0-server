// src/config/rateLimitStore.ts
import Redis from "ioredis";
import { RedisStore } from "rate-limit-redis";
import type { Store } from "express-rate-limit";
import { REDIS_URL, NODE_ENV } from "./env";
import logger from "../utils/logger";

/**
 * Shared Redis client for rate limiting.
 *
 * A single connection is reused across every limiter and (on serverless) across
 * warm invocations of the same instance, so we don't open a new socket per
 * request. Created lazily only when REDIS_URL is configured.
 */
let redisClient: Redis | null = null;

const getRedisClient = (): Redis | null => {
  if (!REDIS_URL) return null;
  if (redisClient) return redisClient;

  redisClient = new Redis(REDIS_URL, {
    // Fail a queued command fast (rather than buffering forever) when Redis is
    // unreachable, so express-rate-limit's passOnStoreError can fail open.
    maxRetriesPerRequest: 1,
    // Disable the internal readiness INFO probe: its promise isn't awaited by
    // us, so on an unreachable server it surfaces as an *unhandled* rejection
    // that would trip the app's global unhandledRejection -> shutdown handler.
    enableReadyCheck: false,
    // Bound how long a single command waits so requests don't hang on an outage.
    commandTimeout: 3000,
  });

  redisClient.on("error", (err) => {
    // Never let a Redis hiccup crash the process; connection errors arrive here
    // as catchable events and per-command failures fail open (passOnStoreError).
    logger.error("Rate limit Redis client error", { error: err.message });
  });

  return redisClient;
};

let warnedNoRedis = false;

/**
 * Build a store for a rate limiter.
 *
 * Returns a Redis-backed store (shared across all serverless instances) when
 * REDIS_URL is set, otherwise `undefined` so express-rate-limit uses its
 * default in-memory store. Each limiter must pass a unique `prefix` so their
 * counters don't collide in the shared Redis keyspace.
 */
export const createRateLimitStore = (prefix: string): Store | undefined => {
  const client = getRedisClient();

  if (!client) {
    // Warn once. In-memory limits are per-instance and reset on cold starts,
    // which is inaccurate on serverless platforms like Vercel.
    if (!warnedNoRedis) {
      warnedNoRedis = true;
      const msg =
        "REDIS_URL is not set - rate limiting uses an in-memory store that is not shared across instances.";
      if (NODE_ENV === "production") {
        logger.warn(msg);
      } else {
        logger.info(msg);
      }
    }
    return undefined;
  }

  const store = new RedisStore({
    prefix,
    // ioredis exposes `.call(command, ...args)` for raw commands, which is
    // exactly the interface rate-limit-redis expects for sendCommand.
    sendCommand: (...args: string[]): Promise<any> =>
      client.call(args[0], ...args.slice(1)) as Promise<any>,
  });

  // rate-limit-redis preloads its Lua scripts in the constructor as un-awaited
  // promises. If Redis is unreachable at startup these reject with no handler,
  // surfacing as an unhandledRejection that would trip the app's global
  // unhandledRejection -> shutdown handler and take the server down. Observe
  // them with a no-op catch so a cold/unreachable Redis can never crash boot.
  // The per-request paths (retryableIncrement / get) reload the scripts on
  // failure, so rate limiting self-heals on the first request once Redis is up.
  const preload = store as unknown as {
    incrementScriptSha?: Promise<unknown>;
    getScriptSha?: Promise<unknown>;
  };
  preload.incrementScriptSha?.catch(() => {});
  preload.getScriptSha?.catch(() => {});

  return store;
};
