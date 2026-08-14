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
    linkedinId = linkedinId?.trim() || undefined;

    const website = normalizeWebsite(company.website);

    const properties: any = {
      name: company.name || "Unknown Company",
    };
    if (linkedinId) properties.linkedin_company_id = linkedinId;
    if (website) properties.domain = website;
    if (company.website) properties.website = company.website;
    if (company.description) properties.description = company.description;
    if (company.locationCity) properties.city = company.locationCity;
    if (company.locationState) properties.state = company.locationState;
    if (company.locationCountry) properties.country = company.locationCountry;
    if (company.employeeCount)
      properties.numberofemployees = company.employeeCount.toString();
    if (ownerId) properties.hubspot_owner_id = ownerId;

    try {
      // Normal case: dedupe via linkedin_company_id, a stable external key.
      if (linkedinId) {
        logger.info(`[HubSpot] Using linkedin_company_id: "${linkedinId}"`);
        const payload = {
          inputs: [
            { properties, idProperty: "linkedin_company_id", id: linkedinId },
          ],
        };
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
      }

      // No linkable LinkedIn company page (and so no linkedin_company_id/
      // domain either) — all we have is a plain-text name. Dedupe by exact
      // NAME instead: without this, every contact synced from the same
      // nameless employer would create its own duplicate company record.
      logger.info(
        `[HubSpot] No LinkedIn company id/URL for "${company.name}" — deduping by name instead`,
      );
      const existingId = await this.findCompanyIdByName(company.name);
      if (existingId) {
        await axios.patch(
          `${this.baseUrl}/crm/v3/objects/companies/${existingId}`,
          { properties },
          { headers: this.headers },
        );
        logger.info(`[HubSpot] Company updated by name match: ${existingId}`);
        return { id: existingId };
      }
      const createResponse = await axios.post(
        `${this.baseUrl}/crm/v3/objects/companies`,
        { properties },
        { headers: this.headers },
      );
      const companyId = createResponse.data.id;
      logger.info(`[HubSpot] Company created (name-only): ${companyId}`);
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

  /**
   * Exact-name lookup, for the no-linkedin_company_id path above only. Best
   * available dedup signal when there's no external id/domain to key off —
   * not a fuzzy/partial match, so a slightly different name (e.g. "SANAI
   * Parts LLC" vs "SANAI Parts") still creates a new company rather than
   * merging into a possibly-wrong existing one. Returns null (never throws)
   * on any search failure, so a transient search error falls through to
   * CREATE rather than failing the whole contact sync.
   */
  private async findCompanyIdByName(name: string | null | undefined): Promise<string | null> {
    const trimmed = name?.trim();
    if (!trimmed) return null;

    try {
      const response = await axios.post(
        `${this.baseUrl}/crm/v3/objects/companies/search`,
        {
          filterGroups: [
            { filters: [{ propertyName: "name", operator: "EQ", value: trimmed }] },
          ],
          properties: ["name"],
          limit: 1,
        },
        { headers: this.headers },
      );
      return response.data?.results?.[0]?.id ?? null;
    } catch (error: any) {
      logger.error(`[HubSpot] Company name search failed: ${error.message}`);
      return null;
    }
  }
}
