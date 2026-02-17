import app from "./app";
import { PORT } from "./config/env";
import logger from "./utils/logger";
import prisma from "./config/prisma";

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
});

process.on("unhandledRejection", (err: Error) => {
  logger.error("Unhandled Rejection:", err);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  server.close(async () => {
    await prisma.$disconnect();
    logger.info("Process terminated");
  });
});
