import axios from "axios";
import crypto from "crypto";
import logger from "../utils/logger";

export function extractLinkedInHandle(url?: string | null): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([^\/?#]+)/i);
  return match?.[1] || null;
}

export function extractCompanySegment(url: string): string | null {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("company");
    if (idx !== -1 && idx + 1 < segments.length) {
      return segments[idx + 1].split("?")[0].split("#")[0];
    }
  } catch {}
  return null;
}

export function normalizeWebsite(website?: string | null): string | null {
  if (!website) return null;
  try {
    const withScheme = /^https?:\/\//i.test(website.trim())
      ? website.trim()
      : `https://${website.trim()}`;
    return new URL(withScheme).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

export async function getOwnerById(
  ownerId: string,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const response = await axios.get(`${baseUrl}/crm/v3/owners/${ownerId}`, {
      headers,
    });
    const owner = response.data;
    return (
      [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim() ||
      owner.email ||
      null
    );
  } catch (err: any) {
    logger.error(`[HubSpot] Failed to fetch owner: ${err.message}`);
    return null;
  }
}

export function mapPriorityToHubSpot(priority: string): string {
  const map: Record<string, string> = { Low: "LOW", Medium: "MEDIUM", High: "HIGH" };
  return map[priority] || "MEDIUM";
}

export function mapPriorityFromHubSpot(priority: string): string {
  const map: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
  return map[priority] || "Medium";
}

export function mapStatusToHubSpot(status: string): string {
  const statusMap: Record<string, string> = {
    "To do": "NOT_STARTED",
    "In progress": "IN_PROGRESS",
    COMPLETED: "COMPLETED",
    Waiting: "WAITING",
    Deferred: "DEFERRED",
  };
  return statusMap[status] || "NOT_STARTED";
}

export function resolveTimeZone(tz?: string): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function convertLocalTimeToUTC(date: string, time: string, timeZone = "UTC"): string {
  const tz = resolveTimeZone(timeZone);
  // "YYYY-MM-DD HH:MM:SS" — matches the Intl formatter's output below exactly,
  // so we can tell when a guess is already correct.
  const targetLocal = `${date} ${time}:00`;
  // The target wall-clock time, taken as a raw numeric value (i.e. as if it
  // were itself a UTC instant). This is the FIXED anchor every correction is
  // measured from — never reassigned. Only `guess` (the current estimate of
  // the true UTC instant) is refined each round.
  const targetAsUtcValue = new Date(`${date}T${time}:00Z`).getTime();

  let guess = new Date(targetAsUtcValue);

  // Iterate toward the UTC instant that actually displays as `targetLocal` in
  // `tz`. Each round measures tz's offset AT THE CURRENT GUESS
  // (offset = displayed(guess) − guess) and applies it to the FIXED target —
  // guess_next = targetAsUtcValue − offset — rather than compounding the
  // correction onto the previous guess, which would drift by roughly one
  // offset per round instead of converging (this is the exact bug caught by
  // verify-dst-fix.ts's round-trip sweep, before this fix).
  //
  // A single correction (the original, pre-fix implementation: compute the
  // offset at the naive guess, apply it once, stop) assumes that offset also
  // holds at the corrected instant — true almost always, but false when the
  // wall-clock time falls near a DST transition: the naive guess and the
  // corrected instant can sit on opposite sides of the transition and have
  // DIFFERENT offsets, leaving the single-correction result off by the
  // transition's jump size (typically an hour). UTC offsets are piecewise-
  // constant, so iterating is guaranteed to converge; real-world zones need
  // at most one extra round beyond the first. Capped at 4 rounds as a safety
  // bound — a wall-clock time that never converges (a DST spring-forward gap,
  // which doesn't correspond to any real instant) exhausts the cap and
  // returns its last estimate rather than looping.
  for (let i = 0; i < 4; i++) {
    const shown = new Intl.DateTimeFormat("sv", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(guess);
    if (shown === targetLocal) break;
    // offset = what tz displays for the current guess, minus the guess itself.
    const offset = new Date(shown + "Z").getTime() - guess.getTime();
    guess = new Date(targetAsUtcValue - offset);
  }

  return guess.toISOString();
}

export function parseHubSpotDateTime(timestamp?: string, timeZone = "UTC"): {
  dueDate: string | null;
  time: string | null;
} {
  if (!timestamp) return { dueDate: null, time: null };
  try {
    const tz = resolveTimeZone(timeZone);
    const d = new Date(timestamp);
    const dueDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    const hour = get("hour") === "24" ? "00" : get("hour");
    return { dueDate, time: `${hour}:${get("minute")}` };
  } catch {
    return { dueDate: null, time: null };
  }
}


export function generateThreadId(conversationKey: string): string {
  // refactored: was require("crypto") inside method body
  const hash = crypto
    .createHash("sha256")
    .update(conversationKey)
    .digest("hex")
    .substring(0, 16);
  return `linkedin_${hash}`;
}
