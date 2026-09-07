// src/services/scheduledNoTouchService.ts
//
// "Scheduled, Never Touched" report (graph #7): active HubSpot contacts with
// Last Activity Date unknown but Next Activity Date known — see
// hubspotLeadSearchService.ts's buildScheduledNoTouchFilters comment for the
// full business definition (the mirror-image quadrant of Forgotten Active
// Leads / NextStepGap's neverTouched segment).
//
// Structurally this is forgottenLeadService.ts (single-count gauge, no
// segmentation) with the table row enriched by the scheduled Next Activity
// Date and sorted by it. See that file's comments for the lazy-snapshot and
// list-cache reasoning — repeated only where this file's behavior differs.
import { ScheduledNoTouchRepository } from "../repositories/scheduledNoTouchRepository";
import {
  countScheduledNoTouchLeads,
  searchScheduledNoTouchLeads,
  ScheduledNoTouchContact,
} from "./hubspotLeadSearchService";
import { HubSpotOAuthService } from "./hubspotOAuthService";
import { parseHubspotDate } from "./nextStepGapService";
import logger from "../utils/logger";

export interface OwnerRef {
  id: string; // our User.id
  hubspotOwnerId: string;
}

function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const failedToday = new Map<string, string>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ScheduledNoTouchRow {
  id: string;
  userId: string;
  name: string;
  email?: string;
  company?: string;
  leadStatus?: string;
  profileUrl: string;
  // ISO string — always present, this graph's filter requires the property.
  nextActivityDate: string | null;
}

// Same shape/reasoning as forgottenLeadService.ts's listCache.
interface ListCacheEntry {
  at: number;
  combined: ScheduledNoTouchRow[];
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

function toRow(c: ScheduledNoTouchContact, userId: string): ScheduledNoTouchRow {
  const d = parseHubspotDate(c.nextActivityRaw);
  return {
    id: c.id,
    userId,
    name: c.name,
    email: c.email,
    company: c.company,
    leadStatus: c.leadStatus,
    profileUrl: c.profileUrl,
    nextActivityDate: d ? d.toISOString() : null,
  };
}

// Soonest/most-overdue scheduled date first — the clearest "about to blow
// up" signal (a task due yesterday with zero contact ever made). Rows with
// an unparseable date sort last rather than floating to the top.
function sortRows(rows: ScheduledNoTouchRow[]): ScheduledNoTouchRow[] {
  return [...rows].sort((a, b) => {
    if (a.nextActivityDate === null && b.nextActivityDate === null) return 0;
    if (a.nextActivityDate === null) return 1;
    if (b.nextActivityDate === null) return -1;
    return a.nextActivityDate.localeCompare(b.nextActivityDate);
  });
}

export class ScheduledNoTouchService {
  static async ensureTodaySnapshots(owners: OwnerRef[]): Promise<void> {
    const today = todayUtcMidnight();
    await Promise.all(
      owners.map(async (owner) => {
        try {
          if (failedToday.get(owner.id) === todayKey()) return;
          const exists = await ScheduledNoTouchRepository.hasSnapshotToday(owner.id, today);
          if (exists) return;
          const token = await HubSpotOAuthService.getValidAccessToken(owner.id);
          const count = await countScheduledNoTouchLeads(token, owner.hubspotOwnerId);
          await ScheduledNoTouchRepository.upsertSnapshot(owner.id, today, count);
        } catch (err: any) {
          logger.warn(
            `[ScheduledNoTouch] snapshot failed for owner ${owner.id}: ${err?.message ?? err}`,
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
    return ScheduledNoTouchRepository.getSeries(from, to, opts);
  }

  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: { granularity?: "day" | "week" | "month" } = {},
  ) {
    return ScheduledNoTouchRepository.getSeriesByOwner(from, to, ownerIds, opts);
  }

  static getTotal(ownerIds: string[]): Promise<number> {
    return ScheduledNoTouchRepository.getLatestTotal(ownerIds);
  }

  static async list(params: {
    page: number;
    limit: number;
    owners: OwnerRef[];
    connectedOnSources?: string[];
  }): Promise<{
    data: ScheduledNoTouchRow[];
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
                const all: ScheduledNoTouchRow[] = [];
                let page_ = 1;
                const pageSize = 200;
                while (all.length < 1000) {
                  const { contacts, total } = await searchScheduledNoTouchLeads(
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
                logger.warn(`[ScheduledNoTouch] list failed for owner ${owner.id}: ${err?.message ?? err}`);
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
