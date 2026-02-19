import winston from "winston";

// Configure Winston logger with file and console transports
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    // Log errors to separate file
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    // Log all levels to combined file
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

// Add console logging in non-production environments
if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  );
}

export default logger;
