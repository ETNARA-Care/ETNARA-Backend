import { Router } from "express";
import { reviewCorporateTask } from "./corporateTaskPostgresReview.js";
import { createCorporateTaskForPlatformAdmin } from "./corporateTaskPostgresCreate.js";
import { listCorporateTasksForPlatformAdmin } from "./corporateTaskPostgresRead.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { withPlatformContext } from "../../context/tenantContext.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";
import { TOWER_AGENTS } from "./agentCatalog.js";
import { TOWER_CORPORATE_AGENTS, TOWER_CORPORATE_DEPARTMENTS } from "./corporateRoster.js";
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
      version: "11.6",
      mode: "read-only",
      liveMonitoringEnabled: true,
      board: buildTowerStatusBoard(observations, new Date().toISOString()),
      departments: TOWER_CORPORATE_DEPARTMENTS,
      corporateAgents: TOWER_CORPORATE_AGENTS,
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
/** Authenticated, platform-only persisted task inbox. Read-only until write approval flows are implemented. */
router.get("/platform/tower/tasks", requireAuth, async (req: AuthenticatedRequest, res) => {
  const rawLimit = req.query.limit;
  const rawAgentId = req.query.agentId;
  if ((rawLimit !== undefined && (typeof rawLimit !== "string" || !/^[1-9][0-9]*$/.test(rawLimit))) ||
      (rawAgentId !== undefined && typeof rawAgentId !== "string")) {
    res.status(400).json({ error: "INVALID_TASK_FILTER" });
    return;
  }
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  try {
    const tasks = await listCorporateTasksForPlatformAdmin(req.auth!.userId, {
      limit, agentId: rawAgentId as string | undefined,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ mode: "read-only", tasks });
  } catch (error) {
    if (error instanceof UnauthorizedPlatformAccessError) {
      res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
      return;
    }
    if (error instanceof RangeError) {
      res.status(400).json({ error: "INVALID_TASK_FILTER" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
router.post("/platform/tower/tasks", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const task = await createCorporateTaskForPlatformAdmin(req.auth!.userId, req.body);
    if (!task) { res.status(400).json({ error: "INVALID_TASK_REQUEST" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ task, executionEnabled: false });
  } catch (error) {
    if (error instanceof UnauthorizedPlatformAccessError) {
      res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
router.post("/platform/tower/tasks/:taskId/review", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await reviewCorporateTask(req.auth!.userId, req.params.taskId, req.body);
    res.setHeader("Cache-Control", "no-store");
    if (result === "invalid") { res.status(400).json({ error: "INVALID_REVIEW" }); return; }
    if (result === "not_found") { res.status(404).json({ error: "TASK_NOT_FOUND" }); return; }
    if (result === "conflict") { res.status(409).json({ error: "TASK_STATUS_CONFLICT" }); return; }
    res.json({ status: "updated", executionEnabled: false });
  } catch (error) {
    if (error instanceof UnauthorizedPlatformAccessError) {
      res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
export default router;
