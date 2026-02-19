import { Request, Response, NextFunction } from "express";
import { validationResult } from "express-validator";
import { errorResponse } from "../utils/apiResponse";

// Middleware to validate request using express-validator
export const validate = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const errors = validationResult(req);

  // Return validation errors if any
  if (!errors.isEmpty()) {
    errorResponse(res, "Validation failed", 400, errors.array());
    return;
  }

  next();
};
