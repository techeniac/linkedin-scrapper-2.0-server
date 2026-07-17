// Resolves the set of HubSpot-CONNECTED app users and their HubSpot display
// names, for the public reporting endpoints. Names come from HubSpot (not our
// users table); users without a HubSpot connection are excluded entirely.
//
// HubSpot is an external, rate-limited API and the owner set changes rarely, so
// results are cached in-memory with a short TTL to avoid a per-request fan-out
// of token refreshes + owner lookups.
import prisma from "../config/prisma";
import { HubSpotOAuthService } from "./hubspotOAuthService";
import { getOwnerById } from "./hubspotHelpers";
import logger from "../utils/logger";

export interface ConnectedOwner {
  id: string; // our User.id
  name: string | null; // HubSpot display name (falls back to DB name on failure)
}

const HUBSPOT_BASE = "https://api.hubapi.com";
// Owners change rarely; a long TTL plus stale-while-revalidate means a user
// request never has to wait on the HubSpot fan-out after the first warm-up.
const TTL_MS = 30 * 60 * 1000;
let cache: { at: number; owners: ConnectedOwner[] } | null = null;
let inFlight: Promise<ConnectedOwner[]> | null = null;

// The actual (slow) load: DB lookup of connected users + a HubSpot name fan-out.
async function loadConnectedOwners(): Promise<ConnectedOwner[]> {
  // "Connected" = fully linked to a real HubSpot owner. Requiring hubspotOwnerId
  // (set only when the user's email matches a HubSpot owner) excludes users who
  // ran the OAuth flow but aren't actual HubSpot owners — those have tokens but
  // no owner id, and would otherwise show up under their DB name.
  const users = await prisma.user.findMany({
    where: {
      hubspotAccessToken: { not: null },
      hubspotRefreshToken: { not: null },
      hubspotOwnerId: { not: null },
    },
    select: { id: true, name: true, hubspotOwnerId: true },
  });

  return Promise.all(
    users.map(async (u): Promise<ConnectedOwner> => {
      let name: string | null = u.name;
      if (u.hubspotOwnerId) {
        try {
          const token = await HubSpotOAuthService.getValidAccessToken(u.id);
          const hsName = await getOwnerById(u.hubspotOwnerId, HUBSPOT_BASE, {
            Authorization: `Bearer ${token}`,
          });
          if (hsName) name = hsName;
        } catch (err: any) {
          logger.warn(
            `[public] HubSpot owner name lookup failed for ${u.id}: ${err?.message}`,
          );
          // keep DB-name fallback
        }
      }
      return { id: u.id, name };
    }),
  );
}

// De-duplicated refresh: concurrent callers share one in-flight load.
function refreshConnectedOwners(): Promise<ConnectedOwner[]> {
  if (!inFlight) {
    inFlight = loadConnectedOwners()
      .then((owners) => {
        cache = { at: Date.now(), owners };
        return owners;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Connected owners with their HubSpot names. Stale-while-revalidate: the first
 * call blocks; after that a warm cache is returned instantly and refreshed in
 * the background once it goes stale, so no user request waits on HubSpot.
 */
export async function getConnectedOwners(): Promise<ConnectedOwner[]> {
  if (!cache) return refreshConnectedOwners(); // cold start — block once
  if (Date.now() - cache.at >= TTL_MS) {
    void refreshConnectedOwners().catch(() => {}); // stale — refresh in background
  }
  return cache.owners; // warm — instant
}

// Warm the cache at boot so the first real request is already fast.
export function prewarmConnectedOwners(): void {
  void refreshConnectedOwners().catch(() => {});
}

export async function getConnectedOwnerIds(): Promise<string[]> {
  return (await getConnectedOwners()).map((o) => o.id);
}

export async function getConnectedOwnerNameMap(): Promise<Map<string, string | null>> {
  return new Map((await getConnectedOwners()).map((o) => [o.id, o.name]));
}
