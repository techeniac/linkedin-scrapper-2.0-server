import axios from "axios";
import { CompanyData } from "../types";
import logger from "../utils/logger";
import { extractCompanySegment, normalizeWebsite } from "./hubspotHelpers";

export class HubSpotCompanyService {
  constructor(
    private baseUrl: string,
    private headers: Record<string, string>,
  ) {}

  async upsertCompany(company: CompanyData, ownerId?: string) {
    logger.info(`[HubSpot] Company upsert starting: ${company.name}`);

    let linkedinId = company.linkedinCompanyId;

    if (!linkedinId && company.companyUrl) {
      linkedinId = extractCompanySegment(company.companyUrl);
    }

    if (!linkedinId) {
      throw new Error(
        `LinkedIn Company ID required. URL: ${company.companyUrl}`,
      );
    }

    linkedinId = linkedinId.trim();
    logger.info(`[HubSpot] Using linkedin_company_id: "${linkedinId}"`);

    const website = normalizeWebsite(company.website);

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
        throw new Error(
          `HubSpot API Error (400): ${errorData?.message || JSON.stringify(errorData)}`,
        );
      } else if (error.response?.status === 401) {
        throw new Error("HubSpot authentication failed. Please reconnect.");
      } else if (error.response?.status === 403) {
        throw new Error("HubSpot permission denied. Check OAuth scopes.");
      }

      throw new Error(`Company sync failed: ${error.message}`);
    }
  }
}
