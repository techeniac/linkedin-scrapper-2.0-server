import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";
import { errorResponse } from "../utils/apiResponse";

interface CustomError extends Error {
  statusCode?: number;
}

// Global error handler middleware
const errorHandler = (
  err: CustomError,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Log error details
  logger.error("Error:", {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  // Send error response
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  errorResponse(res, message, statusCode);
};

export default errorHandler;
