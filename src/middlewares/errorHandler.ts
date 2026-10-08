// src/middlewares/errorHandler.ts
//
// DEBUG: every error response below carries stack/name/request-context
// fields (see the `debug` block) so failures are diagnosable from the HTTP
// response alone, without server log access. This is a deliberate, temporary
// trade-off (stack traces are normally never sent to a caller) — revert once
// log access is restored.
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
    ...((err as any).errors && { errors: (err as any).errors }),
    debug: {
      name: err.name,
      stack: err.stack,
      isAppError,
      method: req.method,
      path: req.originalUrl,
      // Headers a caller controls directly, minus anything secret
      // (x-api-key, authorization, cookie) — useful to confirm what the
      // server actually received without exposing credentials back to it.
      requestHeaders: Object.fromEntries(
        Object.entries(req.headers).filter(
          ([key]) => !["authorization", "x-api-key", "cookie"].includes(key.toLowerCase()),
        ),
      ),
    },
  });
};

export default errorHandler;
