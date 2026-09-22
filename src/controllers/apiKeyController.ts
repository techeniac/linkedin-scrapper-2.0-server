import { Request, Response, NextFunction } from "express";
import { ApiKeyService } from "../services/apiKeyService";
import { successResponse } from "../utils/apiResponse";

// POST /api/auth/api-keys — issues a new key. Gated by `authenticate` (an
// existing logged-in user of THIS app); the raw key is returned exactly
// once and never retrievable again (same pattern as refresh tokens).
export const createApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { name } = req.body as { name: string };
    const result = await ApiKeyService.issue(name);
    successResponse(
      res,
      result,
      "API key created — store it now, it will not be shown again",
      201,
    );
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/api-keys — masked list (keyPrefix only, never the raw key).
export const listApiKeys = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await ApiKeyService.list();
    successResponse(res, result, "API keys retrieved");
  } catch (error) {
    next(error);
  }
};

// DELETE /api/auth/api-keys/:id — revoke (idempotent).
export const revokeApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await ApiKeyService.revoke(req.params.id);
    successResponse(res, null, "API key revoked");
  } catch (error) {
    next(error);
  }
};
