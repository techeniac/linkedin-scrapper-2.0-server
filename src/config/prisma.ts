import { PrismaClient } from "@prisma/client";
import logger from "../utils/logger";

// Supabase's pooler in SESSION mode caps total clients at pool_size (15). Prisma's
// default client pool (num_cpus * 2 + 1) can blow past that on a multi-core host and
// trigger "max clients reached in session mode". Cap our pool well under 15 unless the
// URL already specifies it. We adjust the URL in code (not .env) and pass it via the
// datasources override, so no environment file is touched.
function cappedDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (!u.searchParams.has("connection_limit"))
      u.searchParams.set("connection_limit", "5");
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

// Establish database connection
prisma
  .$connect()
  .then(() => logger.info("Prisma connected to database"))
  .catch((error: any) => {
    logger.error("Prisma connection error:", error);
    process.exit(1);
  });

export default prisma;
