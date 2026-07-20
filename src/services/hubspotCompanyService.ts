import axios from "axios";
import { CompanyData } from "../types";
import logger from "../utils/logger";
import { extractCompanySegment, normalizeWebsite } from "./hubspotHelpers";
import { AppError } from "../errors/AppError";

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

      const status = error.response?.status;
      const msg = error.response?.data?.message || error.message;
      if (status === 400) throw new AppError(`HubSpot API Error (400): ${msg}`, 400);
      if (status === 401) throw new AppError("HubSpot authentication failed. Please reconnect.", 401);
      if (status === 403) throw new AppError("HubSpot permission denied. Check OAuth scopes.", 403);
      if (status === 429) throw new AppError("HubSpot rate limit reached. Please try again later.", 429);
      throw new AppError(`Company sync failed: ${msg}`, 502);
    }
  }
}
