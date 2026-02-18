import axios from "axios";
import {
  ContactData,
  CompanyData,
  SyncLeadResponse,
} from "../types/hubspot.types";
import logger from "../utils/logger";

export class HubSpotSyncService {
  private baseUrl = "https://api.hubapi.com";
  private headers: Record<string, string>;

  constructor(accessToken: string) {
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
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
        const companyResult = await this.upsertCompany(company, ownerId);
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
      } catch (assocErr: any) {
        logger.error(`[HubSpot] Association failed: ${assocErr.message}`);
      }
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
    const handle = this.extractLinkedInHandle(
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
      lifecyclestage: "lead",
      hs_linkedin_url: contact.profileUrl,
    };

    if (contact.email) properties.email = contact.email;
    if (contact.phone) properties.phone = contact.phone;
    if (contact.website) properties.website = contact.website;
    if (contact.locationCity) properties.city = contact.locationCity;
    if (contact.locationState) properties.state = contact.locationState;
    if (contact.locationCountry) properties.country = contact.locationCountry;
    if (handle) properties.linkedin_id = handle;
    // if (contact.hubspotLeadStatus)
    //   properties.hs_lead_status = contact.hubspotLeadStatus;
    // if (contact.hubspotConnectedOnSource)
    //   properties.contact_source = contact.hubspotConnectedOnSource;
    // if (contact.hubspotLeadSource)
    //   properties.approach = contact.hubspotLeadSource;
    if (ownerId) properties.hubspot_owner_id = ownerId;

    const payload = { inputs: [{ properties, idProperty, id: idValue }] };

    try {
      logger.info(`[HubSpot] Contact payload: ${JSON.stringify(payload)}`);
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
        const errorMessage = errorData?.message || JSON.stringify(errorData);
        throw new Error(`HubSpot Contact API Error: ${errorMessage}`);
      }

      throw error;
    }
  }

  async upsertCompany(company: CompanyData, ownerId?: string) {
    logger.info(`[HubSpot] Company upsert starting: ${company.name}`);

    let linkedinId = company.linkedinCompanyId;

    if (!linkedinId && company.companyUrl) {
      linkedinId = this.extractCompanySegment(company.companyUrl);
    }

    if (!linkedinId) {
      throw new Error(
        `LinkedIn Company ID required. URL: ${company.companyUrl}`,
      );
    }

    linkedinId = linkedinId.trim();
    logger.info(`[HubSpot] Using linkedin_company_id: "${linkedinId}"`);

    const website = this.normalizeWebsite(company.website);

    const properties: any = {
      name: company.name || "Unknown Company",
      linkedin_company_id: linkedinId,
    };

    if (website) properties.domain = website;
    if (company.website) properties.website = company.website;
    if (company.description) properties.description = company.description;
    if (company.locationCity) properties.city = company.locationCity;
    if (company.locationState) properties.state = company.locationState;
    if (company.locationCountry) properties.country = company.locationCountry;
    if (company.employeeCount)
      properties.numberofemployees = company.employeeCount.toString();
    if (ownerId) properties.hubspot_owner_id = ownerId;

    const payload = {
      inputs: [
        { properties, idProperty: "linkedin_company_id", id: linkedinId },
      ],
    };

    try {
      const response = await axios.post(
        `${this.baseUrl}/crm/v3/objects/companies/batch/upsert`,
        payload,
        { headers: this.headers },
      );

      if (!response.data.results?.length) {
        throw new Error("HubSpot returned empty results");
      }

      const companyId = response.data.results[0].id;
      logger.info(`[HubSpot] Company upserted successfully: ${companyId}`);
      return { id: companyId };
    } catch (error: any) {
      logger.error(`[HubSpot] Company upsert failed: ${error.message}`);
      logger.error(
        `[HubSpot] Response: ${JSON.stringify(error.response?.data)}`,
      );

      if (error.response?.status === 400) {
        const errorData = error.response.data;
        const errorMessage = errorData?.message || JSON.stringify(errorData);
        throw new Error(`HubSpot API Error (400): ${errorMessage}`);
      } else if (error.response?.status === 401) {
        throw new Error("HubSpot authentication failed. Please reconnect.");
      } else if (error.response?.status === 403) {
        throw new Error("HubSpot permission denied. Check OAuth scopes.");
      }

      throw new Error(`Company sync failed: ${error.message}`);
    }
  }

  async associateContactToCompany(contactId: string, companyId: string) {
    const payload = {
      inputs: [
        {
          from: { id: contactId },
          to: { id: companyId },
          type: "contact_to_company",
        },
      ],
    };

    await axios.post(
      `${this.baseUrl}/crm/v3/associations/contacts/companies/batch/create`,
      payload,
      { headers: this.headers },
    );
  }

  async findContactByProfileUrl(username: string): Promise<{
    id: string;
    firstname?: string;
    lastname?: string;
    email?: string;
    lastmodifieddate?: string;
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
            "lastmodifieddate",
            "hs_object_id",
            "hs_linkedin_url",
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

      return {
        id: matched.id,
        firstname: matched.properties?.firstname,
        lastname: matched.properties?.lastname,
        email: matched.properties?.email,
        lastmodifieddate: matched.properties?.lastmodifieddate,
      };
    } catch (err: any) {
      if (err.response?.status === 404 || err.response?.status === 400)
        return null;
      throw err;
    }
  }

  async addRichNotes(contactId: string, contact: ContactData) {
    let noteContent = `<b>LinkedIn Sync Details</b><br/>`;
    noteContent += `Profile: ${contact.profileUrl}<br/>`;
    noteContent += `Connected On: ${contact.connectedOn || "N/A"}<br/><br/>`;

    if (contact.experiences?.length) {
      noteContent += `<b>Work History:</b><br/>`;
      contact.experiences.forEach((exp) => {
        noteContent += `• ${exp.role} at ${exp.companyLine} (${exp.dates})<br/>`;
      });
    }

    const payload = {
      properties: {
        hs_note_body: noteContent,
        hs_timestamp: new Date().toISOString(),
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 },
          ],
        },
      ],
    };

    await axios.post(`${this.baseUrl}/crm/v3/objects/notes`, payload, {
      headers: this.headers,
    });
  }

  private extractLinkedInHandle(url?: string | null): string | null {
    if (!url) return null;
    const match = url.match(/linkedin\.com\/in\/([^\/?#]+)/i);
    return match?.[1] || null;
  }

  private extractCompanySegment(url: string): string | null {
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

  private normalizeWebsite(website?: string | null): string | null {
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
}
