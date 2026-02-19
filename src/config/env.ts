import dotenv from "dotenv";

dotenv.config();

export const PORT = process.env.PORT || 3000;
export const NODE_ENV = process.env.NODE_ENV || "development";
export const DATABASE_URL = process.env.DATABASE_URL || "";

// JWT authentication configuration
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required in environment variables");
}
export const JWT_SECRET = process.env.JWT_SECRET;
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "15",
);
export const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100");

// HubSpot OAuth configuration
export const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || "";
export const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || "";
export const HUBSPOT_REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || "";
export const HUBSPOT_SCOPES = process.env.HUBSPOT_SCOPES || "";

// CORS configuration
export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:5173"];
