import axios from "axios";
import { ContactData, CompanyData, SyncLeadResponse } from "../types";
import logger from "../utils/logger";
import {
  extractLinkedInHandle,
  getOwnerById,
} from "./hubspotHelpers";
import { HubSpotCompanyService } from "./hubspotCompanyService";

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
        const companyResult = await this.companyService.upsertCompany(company, ownerId);
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
        await this.associateContactToCompany(hubspotContactId, hubspotCompanyId);
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
      lifecyclestage: "",
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
        throw new Error(
          `HubSpot Contact API Error: ${errorData?.message || JSON.stringify(errorData)}`,
        );
      }

      throw error;
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

    await axios.patch(
      `${this.baseUrl}/crm/v3/objects/contacts/${contact.id}`,
      { properties },
      { headers: this.headers },
    );
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

  async addRichNotes(contactId: string, contact: ContactData): Promise<void> {
    let noteContent = `<b>LinkedIn Sync Details</b><br/>`;
    noteContent += `Profile: ${contact.profileUrl}<br/>`;
    noteContent += `Connected On: ${contact.connectedOn || "N/A"}<br/><br/>`;

    if (contact.experiences?.length) {
      noteContent += `<b>Work History:</b><br/>`;
      contact.experiences.forEach((exp) => {
        noteContent += `• ${exp.role} at ${exp.companyLine} (${exp.dates})<br/>`;
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
              { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 },
            ],
          },
        ],
      },
      { headers: this.headers },
    );
  }

  async getPropertyOptions(): Promise<{
    owners: Array<{ label: string; value: string }>;
    lifecycleStages: Array<{ label: string; value: string }>;
    leadStatuses: Array<{ label: string; value: string }>;
    leadSources: Array<{ label: string; value: string }>;
    connectedOnSources: Array<{ label: string; value: string }>;
  }> {
    const [ownersResp, lifecycleResp, leadStatusResp, leadSourceResp, connectedOnResp] =
      await Promise.all([
        axios.get(`${this.baseUrl}/crm/v3/owners`, { headers: this.headers }),
        axios.get(`${this.baseUrl}/crm/v3/properties/contact/lifecyclestage`, { headers: this.headers }),
        axios.get(`${this.baseUrl}/crm/v3/properties/contact/hs_lead_status`, { headers: this.headers }),
        axios.get(`${this.baseUrl}/crm/v3/properties/contact/approach`, { headers: this.headers }),
        axios.get(`${this.baseUrl}/crm/v3/properties/contact/contact_source`, { headers: this.headers }),
      ]);

    return {
      owners: (ownersResp.data?.results || []).map((o: any) => ({
        label:
          [o.firstName, o.lastName].filter(Boolean).join(" ").trim() ||
          o.email ||
          o.id,
        value: String(o.id),
      })),
      lifecycleStages: (lifecycleResp.data?.options || []).map((opt: any) => ({
        label: opt.label,
        value: opt.value,
      })),
      leadStatuses: (leadStatusResp.data?.options || []).map((opt: any) => ({
        label: opt.label,
        value: opt.value,
      })),
      leadSources: (leadSourceResp.data?.options || []).map((opt: any) => ({
        label: opt.label,
        value: opt.value,
      })),
      connectedOnSources: (connectedOnResp.data?.options || []).map((opt: any) => ({
        label: opt.label,
        value: opt.value,
      })),
    };
  }
}
