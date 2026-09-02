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

// Optional shared secret for the unauthenticated /api/public/* endpoints.
// Leave EMPTY to keep them fully open (current behaviour). Set it to require
// `x-api-key: <key>` (or `Authorization: Bearer <key>`) on those routes.
export const PUBLIC_API_KEY = process.env.PUBLIC_API_KEY || "";

// Generic numeric env var with a fallback and inclusive range validation. An
// out-of-range or non-numeric value falls back rather than propagating NaN —
// e.g. into a date computation, where an Invalid Date can throw deep inside
// Intl.DateTimeFormat and 500 an otherwise-unrelated request.
export const numEnv = (
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

// LinkedIn expires sent invitations after ~6 months. Confirmed two ways: its
// help documentation, and observation — an account with ~1 year of continuous
// invitations retains nothing older than 6 months in the Sent list.
// Configurable because LinkedIn has changed this policy before.
export const LINKEDIN_INVITE_EXPIRY_MONTHS = numEnv(
  "LINKEDIN_INVITE_EXPIRY_MONTHS",
  6,
  1,
  60,
);

// Sending an invite and LinkedIn's OWN "Sent" list reflecting it back are not
// perfectly atomic — a reconcile walk that runs within moments of a send can
// find the invite genuinely still missing from LinkedIn's Sent list purely
// due to that lag, not because anything actually resolved. VERIFIED live
// (2026-08-06): an invite sent at 12:56:56 was marked absent, then EXPIRED,
// by 12:58:46 — under 2 minutes later — because two reconcile walks both ran
// before LinkedIn's own list had caught up with the send. A newly-sent row
// is excluded from the absence/expiry check entirely until it's at least
// this old, giving LinkedIn's list time to actually reflect it.
export const RECONCILE_MIN_AGE_MINUTES = numEnv(
  "RECONCILE_MIN_AGE_MINUTES",
  30,
  0,
  24 * 60,
);

// Late Messages report thresholds — see lateMessageService.ts for the full
// reasoning behind quiet hours.
export const LATE_MSG_THRESHOLD_HOURS = numEnv(
  "LATE_MSG_THRESHOLD_HOURS",
  3,
  0,
  24 * 30,
);
export const LATE_MSG_QUIET_START_HOUR = numEnv(
  "LATE_MSG_QUIET_START_HOUR",
  0,
  0,
  23,
);
export const LATE_MSG_QUIET_END_HOUR = numEnv(
  "LATE_MSG_QUIET_END_HOUR",
  7,
  0,
  23,
);
export const LATE_FOLLOWUP_THRESHOLD_DAYS = numEnv(
  "LATE_FOLLOWUP_THRESHOLD_DAYS",
  7,
  1,
  365,
);

// HubSpot OAuth configuration
export const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
export const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || "";
export const HUBSPOT_REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || "";
export const HUBSPOT_SCOPES = process.env.HUBSPOT_SCOPES || "";

// Forgotten Active Leads report: which HubSpot contact properties carry lead
// status / next-activity-date / last-activity-date, and which lead-status
// values count as "not active" (excluded from the report). Configurable
// because these are per-portal property internal names, not HubSpot API
// constants — verified once via scripts/inspectForgottenLeadProperties.ts,
// then set here so a wrong guess or a future portal property rename is an
// env var change, not a redeploy of hubspotLeadSearchService.ts's logic.
export const HUBSPOT_LEAD_STATUS_PROPERTY =
  process.env.HUBSPOT_LEAD_STATUS_PROPERTY || "hs_lead_status";
export const HUBSPOT_NEXT_ACTIVITY_PROPERTY =
  process.env.HUBSPOT_NEXT_ACTIVITY_PROPERTY || "notes_next_activity_date";
export const HUBSPOT_LAST_ACTIVITY_PROPERTY =
  process.env.HUBSPOT_LAST_ACTIVITY_PROPERTY || "notes_last_activity_date";
export const HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES = (
  process.env.HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES || "NOT_INTERESTED,DND_SUSPENDED"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// CORS configuration - allowed origins for cross-origin requests
// Note: chrome-extension:// origins are handled separately in app.ts
export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : [];

