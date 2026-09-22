// Runs before any test file (and before any module it imports) loads.
// src/config/env.ts throws at import time if JWT_SECRET is unset, and
// several services/controllers import it transitively. Loading .env here
// too (not just relying on config/env.ts's own dotenv.config() call) means
// DATABASE_URL is set before config/prisma.ts's module-load-time
// `new PrismaClient()` runs, regardless of which module a test file happens
// to import first.
import dotenv from "dotenv";
dotenv.config();

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
