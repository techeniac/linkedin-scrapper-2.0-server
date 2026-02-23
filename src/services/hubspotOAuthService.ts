import axios from "axios";
import crypto from "crypto";
import prisma from "../config/prisma";
import {
  HUBSPOT_CLIENT_ID,
  HUBSPOT_CLIENT_SECRET,
  HUBSPOT_REDIRECT_URI,
  HUBSPOT_SCOPES,
} from "../config/env";

// Default HubSpot OAuth scopes for CRM access
const DEFAULT_SCOPES = [
  "crm.objects.contacts.write",
  "crm.objects.contacts.read",
  "crm.objects.companies.write",
  "crm.objects.companies.read",
  "crm.objects.owners.read",
];

export class HubSpotOAuthService {
  // Generate HubSpot OAuth authorization URL with secure state
  static async getAuthUrl(userId: string): Promise<string> {
    const scopes = HUBSPOT_SCOPES
      ? HUBSPOT_SCOPES.split(/[\s,]+/).filter(Boolean)
      : DEFAULT_SCOPES;
    const scopesParam = encodeURIComponent(scopes.join(" "));

    // Generate cryptographically secure state
    const state = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store state in database
    await prisma.oAuthState.create({
      data: { state, userId, expiresAt },
    });

    // Clean up expired states
    await prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    return `https://app.hubspot.com/oauth/authorize?client_id=${HUBSPOT_CLIENT_ID}&redirect_uri=${encodeURIComponent(HUBSPOT_REDIRECT_URI)}&scope=${scopesParam}&state=${state}`;
  }

  // Validate OAuth state and return userId
  static async validateState(state: string): Promise<string> {
    const oauthState = await prisma.oAuthState.findUnique({
      where: { state },
    });

    if (!oauthState) {
      throw new Error("Invalid or expired OAuth state");
    }

    if (oauthState.expiresAt < new Date()) {
      await prisma.oAuthState.delete({ where: { state } });
      throw new Error("OAuth state expired");
    }

    // Delete state after validation (one-time use)
    await prisma.oAuthState.delete({ where: { state } });

    return oauthState.userId;
  }

  // Exchange authorization code for access and refresh tokens
  static async exchangeCodeForTokens(code: string) {
    const response = await axios.post(
      "https://api.hubapi.com/oauth/v1/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: HUBSPOT_CLIENT_ID,
        client_secret: HUBSPOT_CLIENT_SECRET,
        redirect_uri: HUBSPOT_REDIRECT_URI,
        code,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      expiresIn: response.data.expires_in,
    };
  }

  // Refresh expired access token using refresh token
  static async refreshAccessToken(refreshToken: string) {
    const response = await axios.post(
      "https://api.hubapi.com/oauth/v1/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: HUBSPOT_CLIENT_ID,
        client_secret: HUBSPOT_CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      expiresIn: response.data.expires_in,
    };
  }

  // Get HubSpot owner ID by email address
  static async getOwnerIdByEmail(
    accessToken: string,
    email: string,
  ): Promise<string | null> {
    try {
      const response = await axios.get("https://api.hubapi.com/crm/v3/owners", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const owner = response.data.results.find(
        (o: any) => o.email?.toLowerCase() === email.toLowerCase(),
      );

      return owner?.id || null;
    } catch (error) {
      console.error("Error fetching HubSpot owners:", error);
      return null;
    }
  }

  // Connect user to HubSpot by exchanging code and storing tokens
  static async connectUser(userId: string, code: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error("User not found");

    const tokens = await this.exchangeCodeForTokens(code);
    const ownerId = await this.getOwnerIdByEmail(
      tokens.accessToken,
      user.email,
    );
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    await prisma.user.update({
      where: { id: userId },
      data: {
        hubspotAccessToken: tokens.accessToken,
        hubspotRefreshToken: tokens.refreshToken,
        hubspotOwnerId: ownerId,
        hubspotTokenExpiresAt: expiresAt,
      },
    });

    return { success: true, ownerId };
  }

  // Get valid access token, refreshing if expired
  static async getValidAccessToken(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.hubspotAccessToken) throw new Error("HubSpot not connected");

    if (user.hubspotTokenExpiresAt && user.hubspotTokenExpiresAt < new Date()) {
      const tokens = await this.refreshAccessToken(user.hubspotRefreshToken!);
      const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

      await prisma.user.update({
        where: { id: userId },
        data: {
          hubspotAccessToken: tokens.accessToken,
          hubspotRefreshToken: tokens.refreshToken,
          hubspotTokenExpiresAt: expiresAt,
        },
      });

      return tokens.accessToken;
    }

    return user.hubspotAccessToken;
  }

  // Disconnect user from HubSpot by removing tokens
  static async disconnectUser(userId: string) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        hubspotAccessToken: null,
        hubspotRefreshToken: null,
        hubspotOwnerId: null,
        hubspotTokenExpiresAt: null,
      },
    });
  }
}
