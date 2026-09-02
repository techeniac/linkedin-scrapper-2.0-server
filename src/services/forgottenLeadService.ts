// src/services/forgottenLeadService.ts
//
// Forgotten Active Leads report: active HubSpot contacts (lead status not
// Not-Interested/DND-Suspended) with no task or activity ever recorded
// against them. See hubspotLeadSearchService.ts for the exact HubSpot filter,
// and the ForgottenLeadSnapshot model comment in schema.prisma for why this
// is snapshot-based rather than an append-only event log like the other 3
// reports.
//
// LAZY SNAPSHOT: ensureTodaySnapshots is called from publicController.getSummary
// on every request, but only ever calls HubSpot for an owner whose row for
// TODAY (UTC) doesn't exist yet — every other call is a single indexed
// existence check. This is the stand-in for a cron job: the first dashboard
// view of the day (across ALL viewers) pays the HubSpot round-trip; every
// later view that day is pure DB reads.
import { ForgottenLeadRepository } from "../repositories/forgottenLeadRepository";
import { countForgottenLeads, searchForgottenLeads } from "./hubspotLeadSearchService";
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

export class ForgottenLeadService {
  /**
   * For every given owner, compute + store today's snapshot IF one doesn't
   * already exist. Failures are logged and skipped per-owner (one owner's
   * expired/revoked HubSpot token must never block the whole dashboard from
   * loading — the chart just shows a gap for that owner today).
   */
  static async ensureTodaySnapshots(owners: OwnerRef[]): Promise<void> {
    const today = todayUtcMidnight();
    await Promise.all(
      owners.map(async (owner) => {
        try {
          const exists = await ForgottenLeadRepository.hasSnapshotToday(owner.id, today);
          if (exists) return;
          const token = await HubSpotOAuthService.getValidAccessToken(owner.id);
          const count = await countForgottenLeads(token, owner.hubspotOwnerId);
          await ForgottenLeadRepository.upsertSnapshot(owner.id, today, count);
        } catch (err: any) {
          logger.warn(
            `[ForgottenLeads] snapshot failed for owner ${owner.id}: ${err?.message ?? err}`,
          );
        }
      }),
    );
  }

  static getSeries(
    from: Date,
    to: Date,
    opts: { userId?: string; restrictUserIds?: string[]; granularity?: "day" | "week" | "month" } = {},
  ) {
    return ForgottenLeadRepository.getSeries(from, to, opts);
  }

  static getSeriesByOwner(
    from: Date,
    to: Date,
    ownerIds: string[],
    opts: { granularity?: "day" | "week" | "month" } = {},
  ) {
    return ForgottenLeadRepository.getSeriesByOwner(from, to, ownerIds, opts);
  }

  /** Latest known backlog size, summed across the given owners — a gauge, not a windowed sum. */
  static getTotal(ownerIds: string[]): Promise<number> {
    return ForgottenLeadRepository.getLatestTotal(ownerIds);
  }

  /**
   * Paginated supporting-table rows: the ACTUAL matching contacts, fetched
   * live from HubSpot (never from the snapshot table, which only stores a
   * count) — scoped to exactly one owner at a time, since HubSpot's Search
   * API filters by a single hubspot_owner_id per call. When multiple owners
   * are in scope, pages are fetched per-owner and concatenated/re-paginated
   * in memory (bounded — see the 1000-contact cap, matching the existing
   * getAllContactsForOwner pattern in hubspotContactService.ts).
   */
  static async list(params: {
    page: number;
    limit: number;
    owners: OwnerRef[]; // already scoped to the requested/allowed owners
  }): Promise<{
    data: Array<{ id: string; userId: string; name: string; email?: string; company?: string; leadStatus?: string; profileUrl: string }>;
    metadata: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 10));

    // Fetch each owner's full matching set (capped at 1000/owner, same bound
    // hubspotContactService.getAllContactsForOwner uses) so multi-owner scope
    // can be paginated as one combined, stably-ordered list.
    const perOwner = await Promise.all(
      params.owners.map(async (owner) => {
        try {
          const token = await HubSpotOAuthService.getValidAccessToken(owner.id);
          const all: Array<ReturnType<typeof mapContact>> = [];
          let page_ = 1;
          const pageSize = 200;
          while (all.length < 1000) {
            const { contacts, total } = await searchForgottenLeads(token, owner.hubspotOwnerId, page_, pageSize);
            all.push(...contacts.map((c) => mapContact(c, owner.id)));
            if (all.length >= total || contacts.length === 0) break;
            page_++;
          }
          return all;
        } catch (err: any) {
          logger.warn(`[ForgottenLeads] list failed for owner ${owner.id}: ${err?.message ?? err}`);
          return [];
        }
      }),
    );

    const combined = perOwner.flat();
    const total = combined.length;
    const start = (page - 1) * limit;
    const data = combined.slice(start, start + limit);

    return {
      data,
      metadata: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }
}

function mapContact(
  c: { id: string; name: string; email?: string; company?: string; leadStatus?: string; profileUrl: string },
  userId: string,
) {
  return { ...c, userId };
}
