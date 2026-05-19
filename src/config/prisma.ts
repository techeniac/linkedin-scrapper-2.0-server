import { PrismaClient } from "@prisma/client";
import logger from "../utils/logger";

// Initialize Prisma client with logging configuration
const prisma = new PrismaClient({
  log: ["error", "warn"],
});

// Connection is established lazily on first query or explicitly via
// prisma.$connect() called in server.ts before the HTTP server starts.

export default prisma;
