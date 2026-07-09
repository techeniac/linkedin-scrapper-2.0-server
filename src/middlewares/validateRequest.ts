import { Request, Response, NextFunction } from "express";
import { validationResult } from "express-validator";
import { ValidationError } from "../errors/AppError";

// Middleware to validate request using express-validator
export const validate = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const err = new ValidationError("Validation failed");
    (err as any).errors = errors.array();
    return next(err);
  }

  next();
};
