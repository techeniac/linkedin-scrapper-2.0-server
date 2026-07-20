import { Request, Response, NextFunction } from "express";

type AsyncFn<T extends Request = Request> = (
  req: T,
  res: Response,
  next: NextFunction,
) => Promise<void>;

// Wraps async route handlers so thrown errors automatically reach the global error handler.
export const asyncHandler =
  <T extends Request = Request>(fn: AsyncFn<T>) =>
  (req: T, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
