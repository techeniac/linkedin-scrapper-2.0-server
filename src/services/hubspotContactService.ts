import axios from "axios";
import { ContactData, CompanyData, SyncLeadResponse } from "../types";
import { ContactListItem, GetContactsByOwnerResponse } from "../types/hubspot.types";
import logger from "../utils/logger";
import { extractLinkedInHandle, getOwnerById, normalizeWebsite } from "./hubspotHelpers";
import { HubSpotCompanyService } from "./hubspotCompanyService";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class HubSpotContactService {
  private companyService: HubSpotCompanyService;

  constructor(
    private baseUrl: string,
    private headers: Record<string, string>,
  ) {
    this.companyService = new HubSpotCompanyService(baseUrl, headers);
  }

  async syncFullLead(
    contact: ContactData,
    company: CompanyData | null,
    ownerId?: string,
  ): Promise<SyncLeadResponse> {
    logger.info(`[HubSpot] Starting sync for: ${contact.name}`);

    let hubspotCompanyId: string | null = null;
    let companySyncError: string | null = null;

    if (company) {
      try {
        logger.info(`[HubSpot] Upserting company: ${company.name}`);
        const companyResult = await this.companyService.upsertCompany(
          company,
          ownerId,
        );
        hubspotCompanyId = companyResult.id;
        logger.info(`[HubSpot] Company upserted: ${hubspotCompanyId}`);
      } catch (err: any) {
        companySyncError = err.message;
        logger.error(`[HubSpot] Company sync failed: ${err.message}`);
      }
    }

    logger.info(`[HubSpot] Upserting contact...`);
    const contactResult = await this.upsertContact(contact, ownerId);
    const hubspotContactId = contactResult.id;
    logger.info(`[HubSpot] Contact upserted: ${hubspotContactId}`);

    if (hubspotContactId && hubspotCompanyId) {
      try {
        logger.info(`[HubSpot] Creating association...`);
        await this.associateContactToCompany(
          hubspotContactId,
          hubspotCompanyId,
        );
        logger.info(`[HubSpot] Association created`);

        // Remove any company associations that HubSpot auto-created from the
        // contact's email domain or that were created by a previous bad sync
        // (e.g. a personal-brand company whose website = the contact's personal site).
        // We identify spurious companies by domain: anything whose domain matches
        // the contact's personal-website domain or email domain — but NOT the real
        // company's domain — is considered spurious and removed.
        const realDomain = normalizeWebsite(company?.website);
        const spuriousDomains = new Set<string>();
        const emailDomain = this.extractEmailDomain(contact.email);
        if (emailDomain && emailDomain !== realDomain) spuriousDomains.add(emailDomain);
        const personalWebDomain = normalizeWebsite(contact.website);
        if (personalWebDomain && personalWebDomain !== realDomain) spuriousDomains.add(personalWebDomain);

        // Immediate cleanup: removes spurious companies from previous bad syncs
        // that are already associated.
        if (spuriousDomains.size > 0) {
          await this.removeSpuriousCompanyAssociations(
            hubspotContactId,
            hubspotCompanyId,
            spuriousDomains,
          );
        }

        // Patch the website now. This may trigger HubSpot's auto-company feature
        // asynchronously (for freemail users it falls back to the website domain).
        // The delayed cleanup below will catch any company HubSpot creates from it.
        if (contact.website) {
          await this.patchContactWebsite(hubspotContactId, contact.website);
        }

        // Delayed cleanup: HubSpot's auto-company feature runs asynchronously —
        // both the email-domain company (triggered at upsert) and the website-domain
        // company (triggered by the patch above) may not exist yet. Running cleanup
        // again 4 seconds later catches both.
        if (spuriousDomains.size > 0) {
          setTimeout(() => {
            this.removeSpuriousCompanyAssociations(
              hubspotContactId,
              hubspotCompanyId!,
              spuriousDomains,
            ).catch((e) =>
              logger.error(`[HubSpot] Delayed cleanup failed: ${e.message}`),
            );
          }, 4000);
        }
      } catch (assocErr: any) {
        logger.error(`[HubSpot] Association failed: ${assocErr.message}`);
      }
    }

    // Standalone contact (no company): still persist the website.
    if (!hubspotCompanyId && contact.website && hubspotContactId) {
      await this.patchContactWebsite(hubspotContactId, contact.website);
    }

    if (contact.experiences?.length) {
      try {
        logger.info(`[HubSpot] Adding notes...`);
        await this.addRichNotes(hubspotContactId, contact);
        logger.info(`[HubSpot] Notes added`);
      } catch (notesErr: any) {
        logger.error(`[HubSpot] Notes failed: ${notesErr.message}`);
      }
    }

    return {
      success: true,
      contactId: hubspotContactId,
      companyId: hubspotCompanyId,
      companySyncError,
    };
  }

  async upsertContact(contact: ContactData, ownerId?: string) {
    const handle = extractLinkedInHandle(
      contact.publicProfileUrl || contact.profileUrl,
    );
    const idProperty = handle ? "linkedin_id" : "email";
    const idValue = handle || contact.email;

    if (!idValue) throw new Error("Email or LinkedIn Handle required");

    const properties: any = {
      firstname: contact.name.split(" ")[0] || "Unknown",
      lastname: contact.name.split(" ").slice(1).join(" ") || "",
      jobtitle: contact.selectedRole || contact.headline || "",
      company: contact.selectedCompany || "",
      hs_linkedin_url: contact.profileUrl,
    };

    if (contact.email) properties.email = contact.email;
    if (contact.phone) properties.phone = contact.phone;
    // website is intentionally excluded here — setting it during upsert triggers
    // HubSpot's "auto-create company" logic for freemail users, which stamps the
    // personal website domain as the primary company. It is patched in separately
    // after the real company association and cleanup are complete.
    if (contact.locationCity) properties.city = contact.locationCity;
    if (contact.locationState) properties.state = contact.locationState;
    if (contact.locationCountry) properties.country = contact.locationCountry;
    if (handle) properties.linkedin_id = handle;
    if (ownerId) properties.hubspot_owner_id = ownerId;

    const payload = { inputs: [{ properties, idProperty, id: idValue }] };

    try {
      const response = await axios.post(
        `${this.baseUrl}/crm/v3/objects/contacts/batch/upsert`,
        payload,
        { headers: this.headers },
      );
      return response.data.results[0];
    } catch (error: any) {
      logger.error(`[HubSpot] Contact upsert failed: ${error.message}`);
      logger.error(
        `[HubSpot] Error response: ${JSON.stringify(error.response?.data)}`,
      );

      if (error.response?.status === 400) {
        const errorData = error.response.data;
        throw new Error(
          `HubSpot Contact API Error: ${errorData?.message || JSON.stringify(errorData)}`,
        );
      }

      throw error;
    }
  }

  private async patchContactWebsite(contactId: string, website: string): Promise<void> {
    try {
      await axios.patch(
        `${this.baseUrl}/crm/v3/objects/contacts/${contactId}`,
        { properties: { website } },
        { headers: this.headers },
      );
    } catch (err: any) {
      logger.error(`[HubSpot] Failed to patch contact website: ${err.message}`);
    }
  }

  async findContactByProfileUrl(username: string): Promise<{
    id: string;
    firstname?: string;
    lastname?: string;
    email?: string;
    company?: string;
    owner?: string;
    phone?: string;
    lifecycleStage?: string;
    lastmodifieddate?: string;
    leadStatus?: string;
    leadSource?: string;
    connectedOnSource?: string;
  } | null> {
    if (!username || !username.trim()) return null;
    const searchPattern = `/in/${username.trim()}`;

    try {
      const response = await axios.post(
        `${this.baseUrl}/crm/v3/objects/contacts/search`,
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "hs_linkedin_url",
                  operator: "CONTAINS_TOKEN",
                  value: searchPattern,
                },
              ],
            },
          ],
          properties: [
            "firstname",
            "lastname",
            "email",
            "company",
            "phone",
            "lastmodifieddate",
            "hubspot_owner_id",
            "lifecyclestage",
            "hs_object_id",
            "hs_linkedin_url",
            "hs_lead_status",
            "approach",
            "contact_source",
          ],
        },
        { headers: this.headers },
      );

      const results = response.data?.results ?? [];
      const matched = results.find((contact: any) => {
        const url = contact.properties?.hs_linkedin_url || "";
        return (
          url.endsWith(`/in/${username}`) || url.endsWith(`/in/${username}/`)
        );
      });

      if (!matched) return null;

      const ownerId = matched.properties?.hubspot_owner_id;
      const ownerName = ownerId
        ? await getOwnerById(ownerId, this.baseUrl, this.headers)
        : null;

      return {
        id: matched.id,
        firstname: matched.properties?.firstname,
        lastname: matched.properties?.lastname,
        email: matched.properties?.email,
        phone: matched.properties?.phone,
        company: matched.properties?.company,
        owner: ownerName || undefined,
        lifecycleStage: matched.properties?.lifecyclestage,
        lastmodifieddate: matched.properties?.lastmodifieddate,
        leadStatus: matched.properties?.hs_lead_status,
        leadSource: matched.properties?.approach,
        connectedOnSource: matched.properties?.contact_source,
      };
    } catch (err: any) {
      if (err.response?.status === 404 || err.response?.status === 400)
        return null;
      throw err;
    }
  }

  async updateContactByUsername(
    username: string,
    updates: {
      name?: string;
      email?: string;
      phone?: string;
      owner?: string;
      lifecycle?: string;
      leadStatus?: string;
      leadSource?: string;
      connectedOnSource?: string;
      company?: string;
    },
  ): Promise<void> {
    const contact = await this.findContactByProfileUrl(username);
    if (!contact) throw new Error("Contact not found in HubSpot");

    const properties: Record<string, string> = {};

    if (updates.name) {
      const nameParts = updates.name.split(" ");
      properties.firstname = nameParts[0] || "";
      properties.lastname = nameParts.slice(1).join(" ") || "";
    }
    if (updates.email) properties.email = updates.email;
    if (updates.phone) properties.phone = updates.phone;
    if (updates.owner) properties.hubspot_owner_id = updates.owner;
    if (updates.lifecycle) properties.lifecyclestage = updates.lifecycle;
    if (updates.leadStatus) properties.hs_lead_status = updates.leadStatus;
    if (updates.leadSource) properties.approach = updates.leadSource;
    if (updates.connectedOnSource)
      properties.contact_source = updates.connectedOnSource;
    if (updates.company) properties.company = updates.company;

    try {
      await axios.patch(
        `${this.baseUrl}/crm/v3/objects/contacts/${contact.id}`,
        { properties },
        { headers: this.headers },
      );
    } catch (error: any) {
      logger.error(`[HubSpot] updateContactByUsername failed: ${error.response?.status ?? error.message}`);
      throw new Error(`Failed to update contact: ${error.response?.data?.message ?? error.message}`);
    }
  }

  async associateContactToCompany(
    contactId: string,
    companyId: string,
  ): Promise<void> {
    await axios.post(
      `${this.baseUrl}/crm/v3/associations/contacts/companies/batch/create`,
      {
        inputs: [
          {
            from: { id: contactId },
            to: { id: companyId },
            type: "contact_to_company",
          },
        ],
      },
      { headers: this.headers },
    );
  }

  private extractEmailDomain(email?: string | null): string | null {
    if (!email) return null;
    const at = email.lastIndexOf("@");
    if (at === -1) return null;
    return email.slice(at + 1).toLowerCase().trim();
  }

  // Removes company associations that were auto-created by HubSpot (e.g. from the
  // contact's email domain) or left over from a previous incorrect sync. Only companies
  // whose `domain` property is in spuriousDomains AND whose ID is not the real company
  // are removed. This is non-destructive — legitimate manually-added companies with
  // different domains are left untouched.
  private async removeSpuriousCompanyAssociations(
    contactId: string,
    realCompanyId: string,
    spuriousDomains: Set<string>,
  ): Promise<void> {
    logger.info(`[HubSpot] Cleanup: contactId=${contactId} realCompanyId=${realCompanyId} spuriousDomains=[${[...spuriousDomains].join(",")}]`);

    let allAssociations: Array<{ id: string }> = [];
    try {
      const assocRes = await axios.get(
        `${this.baseUrl}/crm/v3/objects/contacts/${contactId}/associations/companies`,
        { headers: this.headers },
      );
      allAssociations = assocRes.data?.results ?? [];
      logger.info(`[HubSpot] Cleanup: found ${allAssociations.length} total company association(s): [${allAssociations.map((a: any) => a.id).join(",")}]`);
    } catch (err: any) {
      logger.error(`[HubSpot] Could not fetch company associations: ${err.message}`);
      return;
    }

    const otherIds = allAssociations
      .map((a: any) => String(a.id))
      .filter((id) => id !== String(realCompanyId));

    if (otherIds.length === 0) {
      logger.info(`[HubSpot] Cleanup: no other companies to inspect`);
      return;
    }

    const toRemove: string[] = [];
    for (const cId of otherIds) {
      try {
        const compRes = await axios.get(
          `${this.baseUrl}/crm/v3/objects/companies/${cId}?properties=domain,name`,
          { headers: this.headers },
        );
        const domain: string | undefined = compRes.data?.properties?.domain;
        const name: string | undefined = compRes.data?.properties?.name;
        logger.info(`[HubSpot] Cleanup: company ${cId} name="${name}" domain="${domain}" — spurious=${domain ? spuriousDomains.has(domain) : false}`);
        if (domain && spuriousDomains.has(domain)) {
          toRemove.push(cId);
        }
      } catch {
        // Skip companies we cannot read
      }
    }

    if (toRemove.length === 0) {
      logger.info(`[HubSpot] Cleanup: no spurious companies matched — nothing removed`);
      return;
    }

    try {
      await axios.post(
        `${this.baseUrl}/crm/v3/associations/contacts/companies/batch/archive`,
        {
          inputs: toRemove.map((cId) => ({
            from: { id: contactId },
            to: { id: cId },
          })),
        },
        { headers: this.headers },
      );
      logger.info(`[HubSpot] Cleanup: removed ${toRemove.length} spurious company association(s) [${toRemove.join(",")}] from contact ${contactId}`);
    } catch (err: any) {
      logger.error(`[HubSpot] Could not remove spurious associations: ${err.message}`);
    }
  }

  async addRichNotes(contactId: string, contact: ContactData): Promise<void> {
    let noteContent = `<b>LinkedIn Sync Details</b><br/>`;
    noteContent += `Profile: ${escapeHtml(contact.profileUrl || "")}<br/>`;
    noteContent += `Connected On: ${escapeHtml(contact.connectedOn || "N/A")}<br/><br/>`;

    if (contact.experiences?.length) {
      noteContent += `<b>Work History:</b><br/>`;
      contact.experiences.forEach((exp) => {
        noteContent += `• ${escapeHtml(exp.role || "")} at ${escapeHtml(exp.companyLine || "")} (${escapeHtml(exp.dates || "")})<br/>`;
      });
    }

    await axios.post(
      `${this.baseUrl}/crm/v3/objects/notes`,
      {
        properties: {
          hs_note_body: noteContent,
          hs_timestamp: new Date().toISOString(),
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: 202,
              },
            ],
          },
        ],
      },
      { headers: this.headers },
    );
  }

  async getContactsByOwner(
    ownerId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: "ASCENDING" | "DESCENDING";
    } = {},
  ): Promise<GetContactsByOwnerResponse> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const sortBy = options.sortBy ?? "firstname";
    const sortOrder = options.sortOrder ?? "ASCENDING";
    const after = String((page - 1) * limit);

    const ALLOWED_SORT_FIELDS = new Set([
      "firstname",
      "lastname",
      "email",
      "createdate",
      "lastmodifieddate",
    ]);
    const resolvedSortBy = ALLOWED_SORT_FIELDS.has(sortBy) ? sortBy : "firstname";

    const payload: any = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "hubspot_owner_id",
              operator: "EQ",
              value: ownerId,
            },
          ],
        },
      ],
      properties: ["firstname", "lastname", "email", "company", "phone", "associatedcompanyid"],
      sorts: [{ propertyName: resolvedSortBy, direction: sortOrder }],
      limit,
      after,
    };

    if (options.search?.trim()) {
      payload.query = options.search.trim();
    }

    logger.info(
      `[HubSpot] Fetching contacts for owner ${ownerId}, page=${page}, limit=${limit}, search="${options.search ?? ""}", sort=${resolvedSortBy} ${sortOrder}`,
    );

    try {
      const response = await axios.post(
        `${this.baseUrl}/crm/v3/objects/contacts/search`,
        payload,
        { headers: this.headers },
      );

      const total: number = response.data?.total ?? 0;
      const results: any[] = response.data?.results ?? [];

      // Build initial contacts; note which ones have an associated company ID
      // but no company text property — these need a name lookup.
      const contacts: ContactListItem[] = results.map((r: any) => {
        const first = r.properties?.firstname || "";
        const last = r.properties?.lastname || "";
        return {
          id: r.id,
          name: [first, last].filter(Boolean).join(" ") || r.id,
          email: r.properties?.email || undefined,
          company: r.properties?.company || undefined,
          phone: r.properties?.phone || undefined,
          _associatedCompanyId: r.properties?.associatedcompanyid || undefined,
        } as ContactListItem & { _associatedCompanyId?: string };
      });

      // For contacts missing the company text field but having an association,
      // batch-read the company name from HubSpot in a single call.
      const needsLookup = contacts.filter(
        (c: any) => !c.company && c._associatedCompanyId,
      ) as Array<ContactListItem & { _associatedCompanyId: string }>;

      if (needsLookup.length > 0) {
        try {
          const companyIds = [...new Set(needsLookup.map((c) => c._associatedCompanyId))];
          const batchRes = await axios.post(
            `${this.baseUrl}/crm/v3/objects/companies/batch/read`,
            { properties: ["name"], inputs: companyIds.map((id) => ({ id })) },
            { headers: this.headers },
          );
          const nameMap = new Map<string, string>();
          for (const co of batchRes.data?.results ?? []) {
            if (co.id && co.properties?.name) {
              nameMap.set(String(co.id), co.properties.name);
            }
          }
          for (const c of needsLookup) {
            const name = nameMap.get(c._associatedCompanyId);
            if (name) (c as ContactListItem).company = name;
          }
        } catch (err: any) {
          logger.warn(`[HubSpot] Could not batch-fetch associated company names: ${err.message}`);
        }
      }

      // Strip the internal helper field before returning.
      for (const c of contacts) delete (c as any)._associatedCompanyId;

      return {
        contacts,
        total,
        page,
        limit,
        hasMore: page * limit < total,
      };
    } catch (error: any) {
      logger.error(`[HubSpot] getContactsByOwner failed: ${error.message}`);
      throw error;
    }
  }

  async getAllContactsForOwner(ownerId: string): Promise<ContactListItem[]> {
    const all: ContactListItem[] = [];
    let page = 1;
    const limit = 200;
    while (all.length < 1000) {
      const result = await this.getContactsByOwner(ownerId, { page, limit, sortBy: "firstname" });
      all.push(...result.contacts);
      if (!result.hasMore) break;
      page++;
    }
    return all;
  }

  async getPropertyOptions(): Promise<{
    owners: Array<{ label: string; value: string }>;
    lifecycleStages: Array<{ label: string; value: string }>;
    leadStatuses: Array<{ label: string; value: string }>;
    leadSources: Array<{ label: string; value: string }>;
    connectedOnSources: Array<{ label: string; value: string }>;
  }> {
    const [
      ownersResult,
      lifecycleResult,
      leadStatusResult,
      leadSourceResult,
      connectedOnResult,
    ] = await Promise.allSettled([
      axios.get(`${this.baseUrl}/crm/v3/owners`, { headers: this.headers }),
      axios.get(`${this.baseUrl}/crm/v3/properties/contact/lifecyclestage`, { headers: this.headers }),
      axios.get(`${this.baseUrl}/crm/v3/properties/contact/hs_lead_status`, { headers: this.headers }),
      axios.get(`${this.baseUrl}/crm/v3/properties/contact/approach`, { headers: this.headers }),
      axios.get(`${this.baseUrl}/crm/v3/properties/contact/contact_source`, { headers: this.headers }),
    ]);

    const safeData = (result: PromiseSettledResult<any>, key: string) => {
      if (result.status === "rejected") {
        logger.warn(`[HubSpot] getPropertyOptions: failed to fetch ${key}: ${result.reason?.message}`);
        return null;
      }
      return result.value.data;
    };

    const ownersData = safeData(ownersResult, "owners");
    const lifecycleData = safeData(lifecycleResult, "lifecyclestage");
    const leadStatusData = safeData(leadStatusResult, "hs_lead_status");
    const leadSourceData = safeData(leadSourceResult, "approach");
    const connectedOnData = safeData(connectedOnResult, "contact_source");

    return {
      owners: (ownersData?.results || []).map((o: any) => ({
        label: [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || o.id,
        value: String(o.id),
      })),
      lifecycleStages: (lifecycleData?.options || []).map((opt: any) => ({ label: opt.label, value: opt.value })),
      leadStatuses: (leadStatusData?.options || []).map((opt: any) => ({ label: opt.label, value: opt.value })),
      leadSources: (leadSourceData?.options || []).map((opt: any) => ({ label: opt.label, value: opt.value })),
      connectedOnSources: (connectedOnData?.options || []).map((opt: any) => ({ label: opt.label, value: opt.value })),
    };
  }
}
