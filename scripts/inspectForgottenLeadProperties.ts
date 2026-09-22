// scripts/inspectForgottenLeadProperties.ts
// One-off diagnostic: run manually (`npx ts-node scripts/inspectForgottenLeadProperties.ts`)
// against a real connected portal to confirm the internal property names/option
// values the Forgotten Active Leads graph filters on, before hardcoding any
// env-var default. Prints; does not write anything.
import "../src/config/env";
import axios from "axios";
import prisma from "../src/config/prisma";
import { HubSpotOAuthService } from "../src/services/hubspotOAuthService";

const HUBSPOT_BASE = "https://api.hubapi.com";

async function main() {
  const user = await prisma.user.findFirst({
    where: { hubspotAccessToken: { not: null }, hubspotOwnerId: { not: null } },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error("No HubSpot-connected user found — connect at least one account first.");
    process.exit(1);
  }
  console.log(`Using connected user: ${user.email} (${user.id})`);

  const token = await HubSpotOAuthService.getValidAccessToken(user.id);
  const headers = { Authorization: `Bearer ${token}` };

  console.log("\n--- hs_lead_status options ---");
  const leadStatus = await axios.get(
    `${HUBSPOT_BASE}/crm/v3/properties/contacts/hs_lead_status`,
    { headers },
  );
  for (const opt of leadStatus.data.options ?? []) {
    console.log(`  label="${opt.label}"  value="${opt.value}"`);
  }

  console.log("\n--- all contact properties whose name/label mentions 'activity' ---");
  const allProps = await axios.get(`${HUBSPOT_BASE}/crm/v3/properties/contacts`, { headers });
  for (const p of allProps.data.results ?? []) {
    const haystack = `${p.name} ${p.label}`.toLowerCase();
    if (haystack.includes("activity")) {
      console.log(`  name="${p.name}"  label="${p.label}"  type=${p.type}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err.response?.data ?? err.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
