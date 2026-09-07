// Shared HTTP wrapper for every call to the HubSpot API.
//
// Root cause fix for two symptoms on the lead-hygiene dashboards
// (forgotten-leads / no-next-step / scheduled-no-touch): pages hanging
// indefinitely, and one owner's live table fetch silently returning empty.
// Both traced back to raw axios calls with no timeout and no handling for
// HubSpot's 429 rate limit — a single transient rate limit aborted the
// whole per-owner fetch immediately, and a slow/stuck HubSpot response had
// nothing to cut it off (axios defaults timeout to 0 = never).
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

export const HUBSPOT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
// Bounds one retry wait regardless of what HubSpot's Retry-After asks for, so
// the worst case across a per-owner pagination loop (up to 5 pages, each up
// to MAX_RETRIES retries) stays predictable — see linkedinAPICall.js's
// frontend timeout, which is sized against this cap.
export const MAX_RETRY_DELAY_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryDelayMs(err: any, attempt: number): number {
  const retryAfterHeader = err?.response?.headers?.["retry-after"];
  const retryAfterSeconds = Number(retryAfterHeader);
  const uncapped =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1000
      // Exponential backoff when HubSpot doesn't send Retry-After.
      : DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(uncapped, MAX_RETRY_DELAY_MS);
}

/**
 * axios.request with a fixed timeout and retry-with-backoff on HubSpot's 429
 * (rate limit) response. Any other error (4xx/5xx/network) is not retried —
 * it's surfaced immediately to the caller, same as before.
 */
export async function hubspotRequest<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await axios.request<T>({ ...config, timeout: HUBSPOT_REQUEST_TIMEOUT_MS });
    } catch (err: any) {
      const isRateLimited = err?.response?.status === 429;
      attempt++;
      if (!isRateLimited || attempt > MAX_RETRIES) throw err;
      await delay(retryDelayMs(err, attempt));
    }
  }
}
