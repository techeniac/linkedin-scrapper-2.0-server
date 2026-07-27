import { PrismaClient } from "@prisma/client";
import logger from "../utils/logger";

// Initialize Prisma client with logging configuration
const prisma = new PrismaClient({
  log: ["error", "warn"],
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
