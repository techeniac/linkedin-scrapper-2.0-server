import { PrismaClient } from "@prisma/client";
import logger from "../utils/logger";

const prisma = new PrismaClient({
  log: ["error", "warn"],
});

prisma
  .$connect()
  .then(() => logger.info("Prisma connected to database"))
  .catch((error: any) => {
    logger.error("Prisma connection error:", error);
    process.exit(1);
  });

export default prisma;
