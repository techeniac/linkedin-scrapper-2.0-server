import { PrismaClient } from "@prisma/client";
import logger from "../utils/logger";

// DATABASE_URL runs through Supavisor's TRANSACTION-mode pooler (port 6543,
// `pgbouncer=true`) so serverless function instances share a small number of
// real Postgres backend connections instead of each holding one open for its
// whole lifetime (that was session mode's problem — pool_size: 15 total,
// exhausted by just 3-4 concurrent instances).
//
// The right connection_limit is NOT one fixed number — it depends on which of
// this codebase's two run modes is active:
//   - Vercel (serverless, api/index.ts, no app.listen()): scaling comes from
//     MORE concurrent function instances, not more connections per instance —
//     Prisma's own guidance for serverless + PgBouncer is connection_limit=1.
//   - Local / traditional server (server.ts, app.listen(), one long-running
//     process): the opposite — ONE process serves every concurrent request
//     (e.g. getSummary alone fires 8 parallel queries via Promise.all), so
//     capping at 1 serializes everything onto a single connection and later
//     requests queue up and time out waiting for it to free ("Timed out
//     fetching a new connection from the connection pool").
// Vercel sets process.env.VERCEL automatically on every deployment, so that's
// a reliable signal for which mode is actually running.
const isServerless = !!process.env.VERCEL;

function cappedDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (!u.searchParams.has("connection_limit"))
      u.searchParams.set("connection_limit", isServerless ? "1" : "5");
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
