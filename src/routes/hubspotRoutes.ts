import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { HubSpotOAuthService } from "../services/hubspotOAuthService";
import { successResponse, errorResponse } from "../utils/apiResponse";
import { AuthRequest } from "../types";
import prisma from "../config/prisma";
import hubspotSyncRoutes from "./hubspotSyncRoutes";

const router = Router();

// GET /api/hubspot/connect - Generate HubSpot OAuth URL
router.get("/connect", authenticate, async (req: AuthRequest, res) => {
  try {
    const authUrl = await HubSpotOAuthService.getAuthUrl(req.user!.id);
    successResponse(res, { authUrl }, "HubSpot auth URL generated");
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

// GET /api/hubspot/callback - OAuth callback with state validation
router.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || typeof state !== "string") {
    return res
      .status(400)
      .send(
        "<h1>Connection Failed</h1><p>Missing required OAuth parameters.</p>",
      );
  }

  try {
    // Validate state and get userId
    const userId = await HubSpotOAuthService.validateState(state);

    const result = await HubSpotOAuthService.connectUser(
      userId,
      code as string,
    );

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
    res
      .status(500)
      .send(
        `<h1>Connection Error</h1><p>Authentication failed. Please try again.</p>`,
      );
  }
});

router.post("/disconnect", authenticate, async (req: AuthRequest, res) => {
  try {
    await HubSpotOAuthService.disconnectUser(req.user!.id);
    successResponse(res, null, "HubSpot connection removed");
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

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

router.use("/", hubspotSyncRoutes);

export default router;
