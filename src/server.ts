import app from "./app";
import { PORT } from "./config/env";
import logger from "./utils/logger";
import prisma from "./config/prisma";
import { prewarmConnectedOwners } from "./services/hubspotOwnersService";

// Establish DB connection before accepting any requests
let server: ReturnType<typeof app.listen>;

prisma
  .$connect()
  .then(() => {
    logger.info("Prisma connected to database");
    server = app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      // Warm the connected-owners cache so the first reporting request is fast.
      prewarmConnectedOwners();
    });
  })
  .catch((error: any) => {
    logger.error("Prisma connection error — server will not start:", error);
    process.exit(1);
  });

// Handle unhandled promise rejections
process.on("unhandledRejection", (err: Error) => {
  logger.error("Unhandled Rejection:", err);
  const shutdown = async () => { await prisma.$disconnect(); process.exit(1); };
  server ? server.close(shutdown) : shutdown();
});

// Handle SIGTERM signal for graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  const shutdown = async () => { await prisma.$disconnect(); logger.info("Process terminated"); };
  server ? server.close(shutdown) : shutdown();
});
