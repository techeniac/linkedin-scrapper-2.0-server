import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { HubSpotOAuthService } from "../services/hubspotOAuthService";
import { successResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import prisma from "../config/prisma";
import logger from "../utils/logger";
import { apiLimiter } from "../middlewares/rateLimiter";
import hubspotSyncRoutes from "./hubspotSyncRoutes";
import { asyncHandler } from "../utils/asyncHandler";

const router = Router();

// GET /api/hubspot/connect - Generate HubSpot OAuth URL
router.get(
  "/connect",
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    const authUrl = await HubSpotOAuthService.getAuthUrl(req.user!.id);
    successResponse(res, { authUrl }, "HubSpot auth URL generated");
  }),
);

// GET /api/hubspot/callback - OAuth callback with state validation
// Intentionally keeps local error handling: this route must return HTML, not JSON.
router.get("/callback", apiLimiter, async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || typeof state !== "string") {
    return res
      .status(400)
      .send(
        "<h1>Connection Failed</h1><p>Missing required OAuth parameters.</p>",
      );
  }

  try {
    const userId = await HubSpotOAuthService.validateState(state);
    const result = await HubSpotOAuthService.connectUser(userId, code as string);

    const ownerText = result.ownerId || "Standard User";
    res.send(`
      <html>
        <head>
          <title>HubSpot Connected</title>
          <style>
            body { font-family: sans-serif; text-align: center; padding-top: 50px; }
            .success { color: #28a745; }
          </style>
        </head>
        <body>
          <h1 class="success">✓ HubSpot Connected Successfully!</h1>
          <p>Your owner ID is now linked.</p>
          <p>You can close this window or it will close automatically in 3 seconds.</p>
          <script>
            setTimeout(() => { window.close(); }, 3000);
          </script>
        </body>
      </html>
    `);
  } catch (error: any) {
    logger.error(`[HubSpot OAuth] Callback failed: ${error.message}`);
    res
      .status(500)
      .send(
        `<h1>Connection Error</h1><p>Authentication failed. Please try again.</p>`,
      );
  }
});

// POST /api/hubspot/disconnect - Remove HubSpot connection
router.post(
  "/disconnect",
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    await HubSpotOAuthService.disconnectUser(req.user!.id);
    successResponse(res, null, "HubSpot connection removed");
  }),
);

// GET /api/hubspot/status - Check HubSpot connection status
router.get(
  "/status",
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });

    successResponse(res, {
      connected: !!user?.hubspotAccessToken,
      ownerId: user?.hubspotOwnerId,
    });
  }),
);

// Mount HubSpot sync routes
router.use("/", hubspotSyncRoutes);

export default router;
