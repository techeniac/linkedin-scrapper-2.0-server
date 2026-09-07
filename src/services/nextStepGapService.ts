// src/services/nextStepGapService.ts
//
// "No Next Step Scheduled" report (graph #6): active HubSpot contacts (same
// lead-status exclusion as Forgotten Active Leads) whose Next Activity Date
// is unknown, split into two segments — see hubspotLeadSearchService.ts's
// buildNoNextActivityFilters comment for the full business definition and
// the touched/neverTouched split.
//
// Structurally this is forgottenLeadService.ts with an extra dimension
// (segment) threaded through the same lazy-snapshot + list-cache mechanisms.
// See that file's comments for the reasoning behind each piece — repeated
// only where this file's behavior actually differs.
import { NextStepGapRepository } from "../repositories/nextStepGapRepository";
import {
  countNoNextActivityLeads,
  searchNoNextActivityLeads,
  NoNextActivityContact,
} from "./hubspotLeadSearchService";
import { HubSpotOAuthService } from "./hubspotOAuthService";
import logger from "../utils/logger";

export interface OwnerRef {
  id: string; // our User.id
  hubspotOwnerId: string;
}

function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Same per-process, per-UTC-day failure cap as forgottenLeadService.ts's
// failedToday — see that file's comment.
const failedToday = new Map<string, string>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface NextStepGapRow {
  id: string;
  userId: string;
  name: string;
  email?: string;
  company?: string;
  leadStatus?: string;
  profileUrl: string;
  segment: "touched" | "neverTouched";
  // ISO date string this row's staleness is measured from (Last Activity
  // Date for a touched row, HubSpot Create Date for a never-touched row), or
  // null if HubSpot's raw value couldn't be parsed.
  staleSince: string | null;
  staleDays: number | null;
}

// Same shape/reasoning as forgottenLeadService.ts's listCache — see that
// file's comment in full. Key additionally doesn't need a segment dimension
// since both segments come back from ONE HubSpot call per owner here (see
// searchNoNextActivityLeads).
interface ListCacheEntry {
  at: number;
  combined: NextStepGapRow[];
  partial: boolean;
}
const LIST_CACHE_TTL_MS = 90 * 1000;
const LIST_CACHE_PARTIAL_TTL_MS = 15 * 1000;
const LIST_CACHE_MAX_ENTRIES = 50;
const listCache = new Map<string, ListCacheEntry>();
const listInFlight = new Map<string, Promise<ListCacheEntry>>();

const listCacheTtl = (entry: ListCacheEntry): number =>
  entry.partial ? LIST_CACHE_PARTIAL_TTL_MS : LIST_CACHE_TTL_MS;

function evictExpiredListCacheEntries(): void {
  const now = Date.now();
  for (const [key, entry] of listCache) {
    if (now - entry.at >= listCacheTtl(entry)) listCache.delete(key);
  }
  while (listCache.size > LIST_CACHE_MAX_ENTRIES) {
    const oldestKey = [...listCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (!oldestKey) break;
    listCache.delete(oldestKey);
  }
}

// HubSpot returns date/datetime property values either as epoch-milliseconds
// (a pure-digit string) or as an ISO 8601 string, depending on the property's
// type on this portal — never assume which without checking (see
// scripts/inspectForgottenLeadProperties.ts). Handles both. Exported —
// scheduledNoTouchService.ts reuses this for the same reason.
export function parseHubspotDate(raw: string | null): Date | null {
  if (!raw) return null;
  const asNumber = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const d = Number.isFinite(asNumber) ? new Date(asNumber) : new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function toRow(c: NoNextActivityContact, userId: string): NextStepGapRow {
  const staleSinceDate = parseHubspotDate(c.staleSinceRaw);
  const staleDays = staleSinceDate
    ? Math.max(0, Math.floor((Date.now() - staleSinceDate.getTime()) / (24 * 60 * 60 * 1000)))
    : null;
  return {
    id: c.id,
    userId,
    name: c.name,
    email: c.email,
    company: c.company,
    leadStatus: c.leadStatus,
    profileUrl: c.profileUrl,
    segment: c.segment,
    staleSince: staleSinceDate ? staleSinceDate.toISOString() : null,
    staleDays,
  };
}

// Touched-then-dropped rows first (explicit product decision — a lead
// someone already engaged is the higher-value save), then by staleness
// descending within each segment so the longest-standing gaps surface first.
// Rows with unknown staleness (unparseable HubSpot value) sort last within
// their segment rather than floating to the top as "infinitely stale".
function sortRows(rows: NextStepGapRow[]): NextStepGapRow[] {
  const segmentRank = (s: NextStepGapRow["segment"]) => (s === "touched" ? 0 : 1);
  return [...rows].sort((a, b) => {
    const bySegment = segmentRank(a.segment) - segmentRank(b.segment);
    if (bySegment !== 0) return bySegment;
    if (a.staleDays === null && b.staleDays === null) return 0;
    if (a.staleDays === null) return 1;
    if (b.staleDays === null) return -1;
    return b.staleDays - a.staleDays;
  });
}

export class NextStepGapService {
  /** Lazy daily snapshot — see forgottenLeadService.ts's ensureTodaySnapshots for the full pattern this copies. */
  static async ensureTodaySnapshots(owners: OwnerRef[]): Promise<void> {
    const today = todayUtcMidnight();
    await Promise.all(
      owners.map(async (owner) => {
        try {
          if (failedToday.get(owner.id) === todayKey()) return;
          const exists = await NextStepGapRepository.hasSnapshotToday(owner.id, today);
          if (exists) return;
          const token = await HubSpotOAuthService.getValidAccessToken(owner.id);
          const { touched, neverTouched } = await countNoNextActivityLeads(token, owner.hubspotOwnerId);
          await NextStepGapRepository.upsertSnapshot(owner.id, today, touched, neverTouched);
        } catch (err: any) {
          logger.warn(
            `[NextStepGap] snapshot failed for owner ${owner.id}: ${err?.message ?? err}`,
          );
          failedToday.set(owner.id, todayKey());
        }
      }),
    );
  }

  static getSeries(
    from: Date,
    to: Date,
    opts: { userId?: string; restrictUserIds?: string[]; granularity?: "day" | "week" | "month" } = {},
  ) {
    return NextStepGapRepository.getSeries(from, to, opts);
  }

  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: { granularity?: "day" | "week" | "month" } = {},
  ) {
    return NextStepGapRepository.getSeriesByOwner(from, to, ownerIds, opts);
  }

  /** Latest known (touched, neverTouched) backlog sizes, summed across the given owners — a gauge, not a windowed sum. */
  static getTotals(ownerIds: string[]): Promise<{ touched: number; neverTouched: number }> {
    return NextStepGapRepository.getLatestTotals(ownerIds);
  }

  /**
   * Paginated supporting-table rows — same live-fetch-per-owner-then-cache
   * shape as forgottenLeadService.ts's list(). Sorted per sortRows above
   * BEFORE pagination, so page boundaries stay stable across clicks.
   */
  static async list(params: {
    page: number;
    limit: number;
    owners: OwnerRef[];
    connectedOnSources?: string[];
  }): Promise<{
    data: NextStepGapRow[];
    metadata: { total: number; page: number; limit: number; totalPages: number; partial: boolean };
  }> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));

    const cacheKey = `${params.owners.map((o) => o.id).sort().join(",")}::${(params.connectedOnSources ?? []).slice().sort().join(",")}`;
    const cached = listCache.get(cacheKey);
    let entry: ListCacheEntry;
    if (cached && Date.now() - cached.at < listCacheTtl(cached)) {
      entry = cached;
    } else {
      let inFlight = listInFlight.get(cacheKey);
      if (!inFlight) {
        inFlight = (async (): Promise<ListCacheEntry> => {
          let partial = false;
          const perOwner = await Promise.all(
            params.owners.map(async (owner) => {
              try {
                const token = await HubSpotOAuthService.getValidAccessToken(owner.id);
                const all: NextStepGapRow[] = [];
                let page_ = 1;
                const pageSize = 200;
                while (all.length < 1000) {
                  const { contacts, total } = await searchNoNextActivityLeads(
                    token,
                    owner.hubspotOwnerId,
                    page_,
                    pageSize,
                    params.connectedOnSources,
                  );
                  all.push(...contacts.map((c) => toRow(c, owner.id)));
                  if (all.length >= total || contacts.length === 0) break;
                  page_++;
                }
                return all;
              } catch (err: any) {
                logger.warn(`[NextStepGap] list failed for owner ${owner.id}: ${err?.message ?? err}`);
                partial = true;
                return [];
              }
            }),
          );

          const result: ListCacheEntry = { at: Date.now(), combined: sortRows(perOwner.flat()), partial };
          evictExpiredListCacheEntries();
          listCache.set(cacheKey, result);
          return result;
        })().finally(() => {
          listInFlight.delete(cacheKey);
        });
        listInFlight.set(cacheKey, inFlight);
      }
      entry = await inFlight;
    }

    const total = entry.combined.length;
    const start = (page - 1) * limit;
    const data = entry.combined.slice(start, start + limit);

    return {
      data,
      metadata: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), partial: entry.partial },
    };
  }
}
