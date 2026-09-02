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
import axios from "axios";
import logger from "../utils/logger";
import {
  HUBSPOT_LEAD_STATUS_PROPERTY,
  HUBSPOT_NEXT_ACTIVITY_PROPERTY,
  HUBSPOT_LAST_ACTIVITY_PROPERTY,
  HUBSPOT_FORGOTTEN_EXCLUDED_LEAD_STATUSES,
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
    const response = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      {
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
      { headers: { Authorization: `Bearer ${token}` } },
    );
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

/** Paginated list of the actual matching contacts, for the report's supporting table. */
export async function searchForgottenLeads(
  token: string,
  hubspotOwnerId: string,
  page: number,
  limit: number,
): Promise<{ contacts: ForgottenLeadContact[]; total: number }> {
  const after = String(Math.max(0, (page - 1) * limit));
  try {
    const response = await axios.post(
      `${HUBSPOT_BASE}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [
          {
            filters: [
              { propertyName: "hubspot_owner_id", operator: "EQ", value: hubspotOwnerId },
              ...buildFilterGroups()[0].filters,
            ],
          },
        ],
        properties: ["firstname", "lastname", "email", "company", HUBSPOT_LEAD_STATUS_PROPERTY],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        limit,
        after,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const results: any[] = response.data?.results ?? [];
    const contacts: ForgottenLeadContact[] = results.map((r) => ({
      id: r.id,
      name: [r.properties?.firstname, r.properties?.lastname].filter(Boolean).join(" ") || r.id,
      email: r.properties?.email || undefined,
      company: r.properties?.company || undefined,
      leadStatus: r.properties?.[HUBSPOT_LEAD_STATUS_PROPERTY] || undefined,
      profileUrl: `https://app.hubspot.com/contacts/${r.id}`,
    }));
    return { contacts, total: response.data?.total ?? 0 };
  } catch (err: any) {
    logger.error(
      `[ForgottenLeads] searchForgottenLeads failed for owner ${hubspotOwnerId}: ${err.response?.status ?? err.message}`,
    );
    throw err;
  }
}
