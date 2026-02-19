import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { HubSpotOAuthService } from "../services/hubspotOAuthService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import prisma from "../config/prisma";
import hubspotSyncRoutes from "./hubspotSyncRoutes";

const router = Router();

// GET /api/hubspot/connect - Generate HubSpot OAuth URL
router.get("/connect", authenticate, (req: AuthRequest, res) => {
  try {
    const authUrl = HubSpotOAuthService.getAuthUrl(req.user!.id);
    successResponse(res, { authUrl }, "HubSpot auth URL generated");
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

// GET /api/hubspot/callback - OAuth callback to complete HubSpot connection
router.get("/callback", async (req, res) => {
  const { code, state: userId } = req.query;

  if (!code || !userId) {
    return res
      .status(400)
      .send(
        "<h1>Connection Failed</h1><p>Missing required OAuth parameters.</p>",
      );
  }

  try {
    const result = await HubSpotOAuthService.connectUser(
      userId as string,
      code as string,
    );

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
          <p>Your owner ID (<b>${result.ownerId || "Standard User"}</b>) is now linked.</p>
          <p>You can close this window or it will close automatically in 3 seconds.</p>
          <script>
            setTimeout(() => { window.close(); }, 3000);
          </script>
        </body>
      </html>
    `);
  } catch (error: any) {
    res.status(500).send(`<h1>Connection Error</h1><p>${error.message}</p>`);
  }
});

// POST /api/hubspot/disconnect - Remove HubSpot connection
router.post("/disconnect", authenticate, async (req: AuthRequest, res) => {
  try {
    await HubSpotOAuthService.disconnectUser(req.user!.id);
    successResponse(res, null, "HubSpot connection removed");
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

// GET /api/hubspot/status - Check HubSpot connection status
router.get("/status", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });

    successResponse(res, {
      connected: !!user?.hubspotAccessToken,
      ownerId: user?.hubspotOwnerId,
    });
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

// Mount HubSpot sync routes
router.use("/", hubspotSyncRoutes);

export default router;
