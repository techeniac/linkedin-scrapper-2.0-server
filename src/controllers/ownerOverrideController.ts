// src/controllers/ownerOverrideController.ts
import { Response, NextFunction } from "express";
import { RequesterRequest } from "../middlewares/requesterContext";
import { OwnerOverrideService } from "../services/ownerOverrideService";
import { AmbiguousSortBy, SortOrder } from "../repositories/ownerOverrideRepository";
import { ValidationError } from "../errors/AppError";
import { successResponse } from "../utils/apiResponse";

// Deliberately a fresh, local copy of the same slug-extraction technique as
// publicController.ts's conversationUrlFromKey — that helper is in active
// use by 3 unrelated report endpoints and must not be touched or imported
// cross-module for this feature (see design doc).
const THREAD_SLUG_RE = /2-[A-Za-z0-9_=-]+/;
const conversationUrlFromKey = (conversationKey: string): string | null => {
  const slug = conversationKey.match(THREAD_SLUG_RE)?.[0];
  return slug ? `https://www.linkedin.com/messaging/thread/${slug}/` : null;
};

// --- query param parsers ---
const toStr = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
};
// A fixed page-size menu, not a free-form number — keeps every page a
// predictable, cacheable shape instead of a caller picking an arbitrary
// (and potentially very large) limit.
const ALLOWED_LIMITS = [10, 25, 50, 100] as const;
const toLimit = (v: unknown): number => {
  const n = parseInt(String(v ?? ""), 10);
  return (ALLOWED_LIMITS as readonly number[]).includes(n) ? n : 10;
};
const toPage = (v: unknown): number => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};
const SORT_BY_VALUES: AmbiguousSortBy[] = ["resolvedAt", "participantName"];
const toSortBy = (v: unknown): AmbiguousSortBy =>
  SORT_BY_VALUES.includes(v as AmbiguousSortBy) ? (v as AmbiguousSortBy) : "resolvedAt";
const toSortOrder = (v: unknown): SortOrder => (toStr(v) === "asc" ? "asc" : "desc");

// GET /api/owner-overrides — every conversation currently needing a manual
// resolution, scoped per requireRequesterContext's x-scope rule. Each row
// now includes ambiguousReason (one of the 5 codes, or null for pre-existing
// rows — see design doc) and conversationUrl (null if conversationKey has no
// recognizable LinkedIn thread slug).
// Query params: page? (default 1), limit? (10|25|50|100, default 10),
// sortBy? (resolvedAt|participantName, default resolvedAt),
// sortOrder? (asc|desc, default desc), search? (matches participant name or
// conversationKey, case-insensitive).
export const listOwnerOverrides = async (
  req: RequesterRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await OwnerOverrideService.listAmbiguous({
      requesterEmail: req.requesterEmail!,
      scope: req.requesterScope!,
      page: toPage(req.query.page),
      limit: toLimit(req.query.limit),
      sortBy: toSortBy(req.query.sortBy),
      sortOrder: toSortOrder(req.query.sortOrder),
      search: toStr(req.query.search),
    });
    const data = result.data.map((row) => ({
      ...row,
      conversationUrl: conversationUrlFromKey(row.conversationKey),
    }));
    successResponse(res, { data, metadata: result.metadata }, "Ambiguous conversations retrieved");
  } catch (error) {
    next(error);
  }
};

// POST /api/owner-overrides/:conversationKey — body { ownerId, participantName? }.
// 409 if the conversation isn't currently 'ambiguous'. 400 if participantName
// is present but blank after trimming. Omitting participantName means no
// name change is attempted.
export const applyOwnerOverride = async (
  req: RequesterRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const conversationKey = req.params.conversationKey;
    const ownerId = typeof req.body?.ownerId === "string" ? req.body.ownerId.trim() : "";
    if (!conversationKey || !ownerId) {
      throw new ValidationError("conversationKey and ownerId are required");
    }
    // Absent field vs. present-but-blank are different signals downstream
    // (OwnerOverrideService.applyOverride) — pass the raw string through
    // untrimmed so blank-after-trim can still be rejected there, and leave
    // it undefined (not "") when the field wasn't sent at all.
    const participantName = typeof req.body?.participantName === "string" ? req.body.participantName : undefined;

    await OwnerOverrideService.applyOverride({
      conversationKey,
      newOwnerId: ownerId,
      requesterEmail: req.requesterEmail!,
      scope: req.requesterScope!,
      participantName,
    });
    successResponse(res, { conversationKey, ownerId }, "Owner override applied");
  } catch (error) {
    next(error);
  }
};
