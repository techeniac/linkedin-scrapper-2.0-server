// src/services/hubspotLeadSearchService.ts
//
// HubSpot Search API for the Forgotten Active Leads report: active contacts
// (lead status not in the excluded set) with NEITHER a next activity date NOR
// a last activity date ever recorded — i.e. nobody has created a task or
// logged any activity against them. See config/env.ts for why the property
// names/excluded values are env-driven rather than hardcoded.
//
// This is the ONLY place that builds this feature's HubSpot filterGroups
// payload — forgottenLeadService.ts calls in here for both the daily
// snapshot count and the live supporting-table search, so the filter
// definition can never drift between the two call sites.
import { hubspotRequest } from "../utils/hubspotRequest";
import logger from "../utils/logger";
import {
  HUBSPOT_LEAD_STATUS_PROPERTY,
  HUBSPOT_NEXT_ACTIVITY_PROPERTY,
  HUBSPOT_LAST_ACTIVITY_PROPERTY,
  HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES,
  HUBSPOT_PORTAL_ID,
} from "../config/env";

const HUBSPOT_BASE = "https://api.hubapi.com";

function buildFilterGroups() {
  return [
    {
      filters: [
        {
          propertyName: HUBSPOT_LEAD_STATUS_PROPERTY,
          operator: "NOT_IN",
          values: HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES,
        },
        { propertyName: HUBSPOT_NEXT_ACTIVITY_PROPERTY, operator: "NOT_HAS_PROPERTY" },
        { propertyName: HUBSPOT_LAST_ACTIVITY_PROPERTY, operator: "NOT_HAS_PROPERTY" },
      ],
    },
  ];
}

/** Total count of forgotten active leads for one HubSpot owner. limit=1 — only `total` is read. */
export async function countForgottenLeads(token: string, hubspotOwnerId: string): Promise<number> {
  try {
    const response = await hubspotRequest({
      method: "post",
      url: `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      data: {
        filterGroups: [
          {
            filters: [
              { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
              ...buildFilterGroups()[0].filters,
            ],
          },
        ],
        limit: 1,
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data?.total ?? 0;
  } catch (err: any) {
    logger.error(
      `[ForgottenLeads] countForgottenLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}

export interface ForgottenLeadContact {
  id: string;
  name: string;
  email?: string;
  company?: string;
  leadStatus?: string;
  profileUrl: string;
}

/**
 * Paginated list of the actual matching contacts, for the report's supporting
 * table. `connectedOnSources`, when given, narrows to contacts whose
 * `contact_source` property is one of the given values — the "Connected On"
 * filter (which rep's LinkedIn profile originally sourced this contact),
 * multi-select same as the Sales Person dimension. Table-only: the daily
 * snapshot (`countForgottenLeads`, used for the chart) is deliberately NOT
 * split by this dimension, since the snapshot only stores one count per
 * (owner, day) — adding a per-source breakdown there would need a schema
 * change, not justified for a filter that only narrows a live table.
 */
export async function searchForgottenLeads(
  token: string,
  hubspotOwnerId: string,
  page: number,
  limit: number,
  connectedOnSources?: string[],
): Promise<{ contacts: ForgottenLeadContact[]; total: number }> {
  const after = String(Math.max(0, (page - 1) * limit));
  try {
    const response = await hubspotRequest({
      method: "post",
      url: `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      data: {
        filterGroups: [
          {
            filters: [
              { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
              ...buildFilterGroups()[0].filters,
              ...(connectedOnSources?.length
                ? [{ propertyName: "contact_source", operator: "IN", values: connectedOnSources }]
                : []),
            ],
          },
        ],
        properties: ["firstname", "lastname", "email", "company", HUBSPOT_LEAD_STATUS_PROPERTY],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        limit,
        after,
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    const results: any[] = response.data?.results ?? [];
    const contacts: ForgottenLeadContact[] = results.map((r) => ({
      id: r.id,
      name: [r.properties?.firstname, r.properties?.lastname].filter(Boolean).join(" ") || r.id,
      email: r.properties?.email || undefined,
      company: r.properties?.company || undefined,
      leadStatus: r.properties?.[HUBSPOT_LEAD_STATUS_PROPERTY] || undefined,
      // Portal ID is required here — without it HubSpot reads `r.id` as the
      // portal/account id and shows an access-denied page instead of the
      // contact. See config/env.ts's HUBSPOT_PORTAL_ID comment for where to find it.
      profileUrl: `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/contact/${r.id}`,
    }));
    return { contacts, total: response.data?.total ?? 0 };
  } catch (err: any) {
    logger.error(
      `[ForgottenLeads] searchForgottenLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}

// --- No Next Step Scheduled (graph #6) ---
//
// Active contacts (same lead-status exclusion as Forgotten Active Leads)
// whose Next Activity Date is unknown — i.e. nobody has anything scheduled
// for them. UNLIKE Forgotten Active Leads, this does NOT also require Last
// Activity Date to be unknown: a contact someone engaged once and then
// dropped still counts here. That distinction is what splits every result
// into two segments:
//   touched      : Last Activity Date IS known — a relationship already
//                  started and then went cold (the higher-priority "dropped
//                  ball").
//   neverTouched : Last Activity Date is ALSO unknown — nobody has ever
//                  engaged this lead at all.
// Same one-place-builds-the-filter discipline as buildFilterGroups above —
// nextStepGapService.ts calls in here for both the daily snapshot counts and
// the live supporting-table search.
function buildNoNextActivityFilters() {
  return [
    { propertyName: HUBSPOT_LEAD_STATUS_PROPERTY, operator: "NOT_IN", values: HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES },
    { propertyName: HUBSPOT_NEXT_ACTIVITY_PROPERTY, operator: "NOT_HAS_PROPERTY" },
  ];
}

async function countWithFilters(
  token: string,
  hubspotOwnerId: string,
  extraFilters: Array<Record<string, unknown>>,
): Promise<number> {
  const response = await hubspotRequest({
    method: "post",
    url: `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
    data: {
      filterGroups: [
        {
          filters: [
            { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
            ...buildNoNextActivityFilters(),
            ...extraFilters,
          ],
        },
      ],
      limit: 1,
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data?.total ?? 0;
}

/**
 * Counts for one HubSpot owner, split into the touched / never-touched
 * segments. Two separate HubSpot Search calls (HubSpot's count endpoint has
 * no GROUP BY) run in parallel — each limit=1, only `total` is read.
 */
export async function countNoNextActivityLeads(
  token: string,
  hubspotOwnerId: string,
): Promise<{ touched: number; neverTouched: number }> {
  try {
    const [touched, neverTouched] = await Promise.all([
      countWithFilters(token, hubspotOwnerId, [
        { propertyName: HUBSPOT_LAST_ACTIVITY_PROPERTY, operator: "HAS_PROPERTY" },
      ]),
      countWithFilters(token, hubspotOwnerId, [
        { propertyName: HUBSPOT_LAST_ACTIVITY_PROPERTY, operator: "NOT_HAS_PROPERTY" },
      ]),
    ]);
    return { touched, neverTouched };
  } catch (err: any) {
    logger.error(
      `[NextStepGap] countNoNextActivityLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}

export interface NoNextActivityContact extends ForgottenLeadContact {
  segment: "touched" | "neverTouched";
  // Last Activity Date for a touched contact, else the HubSpot Create Date —
  // whichever the segment's staleness is measured from. Both are raw
  // HubSpot property strings (epoch-ms for the activity date, ISO for
  // createdate) — see nextStepGapService.ts's staleness computation.
  staleSinceRaw: string | null;
}

/**
 * Paginated list of the actual matching contacts, for the report's
 * supporting table — same shape/role as searchForgottenLeads above, but NOT
 * filtered by Last Activity Date, so both segments come back in one call and
 * are labeled per-contact (`segment`) rather than fetched as two separate
 * queries. `connectedOnSources` narrows the same way as
 * searchForgottenLeads.
 */
export async function searchNoNextActivityLeads(
  token: string,
  hubspotOwnerId: string,
  page: number,
  limit: number,
  connectedOnSources?: string[],
): Promise<{ contacts: NoNextActivityContact[]; total: number }> {
  const after = String(Math.max(0, (page - 1) * limit));
  try {
    const response = await hubspotRequest({
      method: "post",
      url: `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      data: {
        filterGroups: [
          {
            filters: [
              { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
              ...buildNoNextActivityFilters(),
              ...(connectedOnSources?.length
                ? [{ propertyName: "contact_source", operator: "IN", values: connectedOnSources }]
                : []),
            ],
          },
        ],
        properties: [
          "firstname",
          "lastname",
          "email",
          "company",
          HUBSPOT_LEAD_STATUS_PROPERTY,
          HUBSPOT_LAST_ACTIVITY_PROPERTY,
          "createdate",
        ],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        limit,
        after,
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    const results: any[] = response.data?.results ?? [];
    const contacts: NoNextActivityContact[] = results.map((r) => {
      const lastActivity = r.properties?.[HUBSPOT_LAST_ACTIVITY_PROPERTY] || null;
      return {
        id: r.id,
        name: [r.properties?.firstname, r.properties?.lastname].filter(Boolean).join(" ") || r.id,
        email: r.properties?.email || undefined,
        company: r.properties?.company || undefined,
        leadStatus: r.properties?.[HUBSPOT_LEAD_STATUS_PROPERTY] || undefined,
        profileUrl: `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/contact/${r.id}`,
        segment: lastActivity ? "touched" : "neverTouched",
        staleSinceRaw: lastActivity || r.properties?.createdate || null,
      };
    });
    return { contacts, total: response.data?.total ?? 0 };
  } catch (err: any) {
    logger.error(
      `[NextStepGap] searchNoNextActivityLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}

// --- Scheduled, Never Touched (graph #7) ---
//
// Active contacts (same lead-status exclusion as the other 2 HubSpot-state
// graphs) where Last Activity Date is unknown BUT Next Activity Date IS
// known — the mirror-image quadrant of buildFilterGroups above (Forgotten
// Active Leads requires BOTH unknown) and of the "neverTouched" segment of
// buildNoNextActivityFilters (same). A rep scheduled something for a contact
// they've never actually engaged. Same one-place-builds-the-filter
// discipline as the other two — scheduledNoTouchService.ts calls in here for
// both the daily snapshot count and the live supporting-table search.
function buildScheduledNoTouchFilters() {
  return [
    { propertyName: HUBSPOT_LEAD_STATUS_PROPERTY, operator: "NOT_IN", values: HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES },
    { propertyName: HUBSPOT_LAST_ACTIVITY_PROPERTY, operator: "NOT_HAS_PROPERTY" },
    { propertyName: HUBSPOT_NEXT_ACTIVITY_PROPERTY, operator: "HAS_PROPERTY" },
  ];
}

/** Total count of scheduled-but-never-touched leads for one HubSpot owner. limit=1 — only `total` is read. */
export async function countScheduledNoTouchLeads(token: string, hubspotOwnerId: string): Promise<number> {
  try {
    const response = await hubspotRequest({
      method: "post",
      url: `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      data: {
        filterGroups: [
          {
            filters: [
              { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
              ...buildScheduledNoTouchFilters(),
            ],
          },
        ],
        limit: 1,
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data?.total ?? 0;
  } catch (err: any) {
    logger.error(
      `[ScheduledNoTouch] countScheduledNoTouchLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}

export interface ScheduledNoTouchContact extends ForgottenLeadContact {
  // Raw HubSpot Next Activity Date value (epoch-ms or ISO string, portal-
  // dependent — see nextStepGapService.ts's parseHubspotDate for why both
  // are handled). Always present — this graph's filter REQUIRES it.
  nextActivityRaw: string | null;
}

/**
 * Paginated list of the actual matching contacts, for the report's
 * supporting table — same shape/role as searchForgottenLeads /
 * searchNoNextActivityLeads. `connectedOnSources` narrows the same way.
 */
export async function searchScheduledNoTouchLeads(
  token: string,
  hubspotOwnerId: string,
  page: number,
  limit: number,
  connectedOnSources?: string[],
): Promise<{ contacts: ScheduledNoTouchContact[]; total: number }> {
  const after = String(Math.max(0, (page - 1) * limit));
  try {
    const response = await hubspotRequest({
      method: "post",
      url: `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      data: {
        filterGroups: [
          {
            filters: [
              { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
              ...buildScheduledNoTouchFilters(),
              ...(connectedOnSources?.length
                ? [{ propertyName: "contact_source", operator: "IN", values: connectedOnSources }]
                : []),
            ],
          },
        ],
        properties: [
          "firstname",
          "lastname",
          "email",
          "company",
          HUBSPOT_LEAD_STATUS_PROPERTY,
          HUBSPOT_NEXT_ACTIVITY_PROPERTY,
        ],
        // Soonest/most-overdue scheduled date first — matches the report
        // table's default sort (see scheduledNoTouchService.ts).
        sorts: [{ propertyName: HUBSPOT_NEXT_ACTIVITY_PROPERTY, direction: "ASCENDING" }],
        limit,
        after,
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    const results: any[] = response.data?.results ?? [];
    const contacts: ScheduledNoTouchContact[] = results.map((r) => ({
      id: r.id,
      name: [r.properties?.firstname, r.properties?.lastname].filter(Boolean).join(" ") || r.id,
      email: r.properties?.email || undefined,
      company: r.properties?.company || undefined,
      leadStatus: r.properties?.[HUBSPOT_LEAD_STATUS_PROPERTY] || undefined,
      profileUrl: `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/contact/${r.id}`,
      nextActivityRaw: r.properties?.[HUBSPOT_NEXT_ACTIVITY_PROPERTY] || null,
    }));
    return { contacts, total: response.data?.total ?? 0 };
  } catch (err: any) {
    logger.error(
      `[ScheduledNoTouch] searchScheduledNoTouchLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}
