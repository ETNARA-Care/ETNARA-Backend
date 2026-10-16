import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { withPlatformContext } from "../../context/tenantContext.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";
import { TOWER_AGENTS } from "./agentCatalog.js";
import { buildTowerStatusBoard } from "./statusBoard.js";
import { collectTowerLiveHealth } from "./liveHealthCollector.js";

const router = Router();
/** Platform-only, read-only bootstrap. Live provider collection is not enabled yet. */
router.get("/platform/tower/overview", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    // Recheck platform authority in the database; never trust a frontend role or header.
    await withPlatformContext(req.auth!.userId, async () => true);
    res.setHeader("Cache-Control", "no-store");
    const observations = await collectTowerLiveHealth(req.auth!.userId, new Date().toISOString());
    res.json({
      version: "11.5",
      mode: "read-only",
      liveMonitoringEnabled: true,
      board: buildTowerStatusBoard(observations, new Date().toISOString()),
      agents: TOWER_AGENTS.map(agent => ({
        id: agent.id,
        name: agent.name,
        responsibilities: agent.responsibilities,
        mode: "planning-only",
      })),
    });
  } catch (error) {
    if (error instanceof UnauthorizedPlatformAccessError) {
      res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
export default router;
