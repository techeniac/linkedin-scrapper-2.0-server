import { PrismaClient } from "@prisma/client";
import logger from "../utils/logger";

// DATABASE_URL runs through Supavisor's TRANSACTION-mode pooler (port 6543,
// `pgbouncer=true`) so serverless function instances share a small number of
// real Postgres backend connections instead of each holding one open for its
// whole lifetime (that was session mode's problem — pool_size: 15 total,
// exhausted by just 3-4 concurrent instances). In transaction mode, scaling
// comes from MORE concurrent instances, not more connections per instance —
// Prisma's own guidance for serverless + PgBouncer is connection_limit=1.
// We adjust the URL in code (not .env) and pass it via the datasources
// override, so no environment file is touched.
function cappedDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (!u.searchParams.has("connection_limit"))
      u.searchParams.set("connection_limit", "1");
    if (!u.searchParams.has("pool_timeout"))
      u.searchParams.set("pool_timeout", "20");
    return u.toString();
  } catch {
    return raw; // non-standard URL — leave as-is
  }
}

// Initialize Prisma client with logging configuration
const prisma = new PrismaClient({
  log: ["error", "warn"],
  datasources: { db: { url: cappedDatabaseUrl() } },
});

// Connection is established lazily on first query or explicitly via
// prisma.$connect() called in server.ts before the HTTP server starts.

export default prisma;
