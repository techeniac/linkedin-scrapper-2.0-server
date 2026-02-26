// src/middlewares/errorHandler.ts
import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";
import { AppError } from "../errors/AppError";

const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const message = err.message || "Internal Server Error";

  logger.error("Error:", {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    statusCode,
  });

  res.status(statusCode).json({
    success: false,
    message,
    timestamp: new Date().toISOString(),
    path: req.url,
  });
};

export default errorHandler;
