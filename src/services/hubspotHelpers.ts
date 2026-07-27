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
  // Treat the local date+time as UTC initially, then find the true offset in the target timezone
  const localAsUtc = new Date(`${date}T${time}:00Z`);
  const tzDisplay = new Intl.DateTimeFormat("sv", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(localAsUtc);
  // diff = what timezone shows minus what we want — subtract to get real UTC
  const diff = new Date(tzDisplay + "Z").getTime() - localAsUtc.getTime();
  return new Date(localAsUtc.getTime() - diff).toISOString();
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

// dead code: combineDateTimeToTimestamp — never called, preserved as-is
export function combineDateTimeToTimestamp(
  date?: string,
  time?: string,
): string | null {
  if (!date) return null;
  const timeStr = time || "00:00";
  try {
    return new Date(`${date}T${timeStr}:00.000Z`).getTime().toString();
  } catch {
    return null;
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
