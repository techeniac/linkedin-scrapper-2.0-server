import app from "./app";
import { PORT } from "./config/env";
import logger from "./utils/logger";
import prisma from "./config/prisma";

// Start the server
const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (err: Error) => {
  logger.error("Unhandled Rejection:", err);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(1);
  });
});

// Handle SIGTERM signal for graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  server.close(async () => {
    await prisma.$disconnect();
    logger.info("Process terminated");
  });
});
