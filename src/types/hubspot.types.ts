export interface ContactData {
  name: string;
  profileUrl: string;
  publicProfileUrl?: string | null;
  canonicalProfileUrl?: string | null;
  headline?: string | null;
  selectedRole?: string | null;
  selectedCompany?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  location?: string | null;
  locationCity?: string | null;
  locationState?: string | null;
  locationCountry?: string | null;
  profileImage?: string | null;
  connections?: string | null;
  followers?: string | null;
  education?: string | null;
  pronouns?: string | null;
  connectedOn?: string | null;
  hubspotLeadStatus?: string | null;
  hubspotConnectedOnSource?: string | null;
  hubspotLeadSource?: string | null;
  experiences?: ExperienceData[];
}

export interface ExperienceData {
  role?: string | null;
  companyLine?: string | null;
  dates?: string | null;
  location?: string | null;
  skillsSummary?: string | null;
}

export interface CompanyData {
  name?: string | null;
  website?: string | null;
  phone?: string | null;
  industry?: string | null;
  employeeCount?: number | null;
  locationCity?: string | null;
  locationState?: string | null;
  locationCountry?: string | null;
  companyUrl: string;
  description?: string | null;
  linkedinCompanyId?: string | null;
}

export interface SyncLeadRequest {
  contact: ContactData;
  company?: CompanyData | null;
}

export interface SyncLeadResponse {
  success: boolean;
  contactId: string;
  companyId?: string | null;
  companySyncError?: string | null;
}
