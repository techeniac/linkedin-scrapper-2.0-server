import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Server configuration
export const PORT = process.env.PORT || 3000;
export const NODE_ENV = process.env.NODE_ENV || "development";
export const DATABASE_URL = process.env.DATABASE_URL || "";

// JWT authentication configuration
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required in environment variables");
}
export const JWT_SECRET = process.env.JWT_SECRET;
// Kept as a fallback; access tokens now use ACCESS_TOKEN_TTL.
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

// Access token: short-lived JWT. Refresh token: long-lived opaque token.
export const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || "15m";
export const REFRESH_TOKEN_TTL_DAYS = parseInt(
  process.env.REFRESH_TOKEN_TTL_DAYS || "7",
);

// Password-reset OTP configuration.
export const RESET_CODE_TTL_MINUTES = parseInt(
  process.env.RESET_CODE_TTL_MINUTES || "10",
);
export const RESET_CODE_MAX_ATTEMPTS = parseInt(
  process.env.RESET_CODE_MAX_ATTEMPTS || "5",
);

// SMTP configuration for transactional email (password-reset codes).
export const SMTP_HOST = process.env.SMTP_HOST || "";
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587");
export const SMTP_USER = process.env.SMTP_USER || "";
export const SMTP_PASS = process.env.SMTP_PASS || "";
export const SMTP_FROM =
  process.env.SMTP_FROM || "HubLead <no-reply@hublead.local>";

// Rate limiting configuration (window in minutes, max requests per window)
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "15",
);
export const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100");

// Shared store for rate limiting. Set to an Upstash (or any) Redis connection
// string (e.g. rediss://default:<token>@<host>:<port>) so limits are enforced
// across all serverless instances. When empty, limiters fall back to an
// in-memory store that is per-instance only.
export const REDIS_URL = process.env.REDIS_URL || "";

// HubSpot OAuth configuration
export const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
export const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || "";
export const HUBSPOT_REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || "";
export const HUBSPOT_SCOPES = process.env.HUBSPOT_SCOPES || "";

// CORS configuration - allowed origins for cross-origin requests
// Note: chrome-extension:// origins are handled separately in app.ts
export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : [];

