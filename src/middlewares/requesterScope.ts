import { Response, NextFunction } from "express";
import { getConnectedOwnerByEmail } from "../services/hubspotOwnersService";
import { PublicApiRequest } from "../types";
import { ForbiddenError, ValidationError } from "../errors/AppError";
import logger from "../utils/logger";

const toStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const header = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

// Runs after requireApiKey. Resolves who this call is on behalf of and what
// they're allowed to see, from three trusted headers (see spec §3):
//   x-requester-email (required) — who this call is on behalf of.
//   x-scope: all (optional)      — unrestricted access (super_admin).
//   x-scope-emails (optional)    — comma-separated emails this person may
//                                   see; the requester's own id is always
//                                   included even if omitted from the list.
// Fail-closed: neither optional header given -> self only (req.scopeOwnerIds
// = [requesterOwnerId]). An x-requester-email that isn't a recognized
// connected owner is a 403; a missing one is a 400.
export const resolveRequesterScope = async (
  req: PublicApiRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const requesterEmail = toStr(header(req.headers["x-requester-email"]));
    if (!requesterEmail) {
      return next(new ValidationError("x-requester-email header is required"));
    }

    const requester = await getConnectedOwnerByEmail(requesterEmail);
    if (!requester) {
      return next(new ForbiddenError("Requester is not a recognized owner"));
    }

    req.requesterOwnerId = requester.id;

    const scopeHeader = toStr(header(req.headers["x-scope"]));
    if (scopeHeader === "all") {
      req.scopeOwnerIds = null;
      return next();
    }

    const scopeEmailsHeader = toStr(header(req.headers["x-scope-emails"]));
    if (scopeEmailsHeader) {
      const emails = scopeEmailsHeader
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      const resolved = new Set<string>();
      for (const email of emails) {
        const scopedOwner = await getConnectedOwnerByEmail(email);
        if (scopedOwner) {
          resolved.add(scopedOwner.id);
        } else {
          logger.warn("[requesterScope] dropping unrecognized scope email", { email });
        }
      }
      resolved.add(requester.id); // always include the requester's own id
      req.scopeOwnerIds = Array.from(resolved);
      return next();
    }

    req.scopeOwnerIds = [requester.id]; // safe default: self only
    next();
  } catch (error) {
    next(error);
  }
};
