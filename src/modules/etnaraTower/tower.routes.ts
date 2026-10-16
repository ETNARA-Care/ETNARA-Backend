import { Router } from "express";
import { validateRepairPrIntent } from "./repairPrPreflight.js";
import { buildReadOnlyRepairPlan } from "./repairPlanPilot.js";
import { listTaskAuditForAdmin } from "./corporateTaskPostgresAuditRead.js";
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
/** First agent pilot: explicit, allowlisted, platform-admin-only read-only health check. */
router.get("/platform/tower/pilot/health/:agentId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agentId = String(req.params.agentId);
  if (agentId !== "technology-4" && agentId !== "technology-3") {
    res.status(400).json({ error: "PILOT_AGENT_NOT_ENABLED" });
    return;
  }
  try {
    await withPlatformContext(req.auth!.userId, async () => true);
    const checkedAt = new Date().toISOString();
    const observations = await collectTowerLiveHealth(req.auth!.userId, checkedAt);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      agentId, checkedAt, capability: "read-only-health-check",
      executionMode: "bounded-read-only", autonomousExecutionEnabled: false,
      board: buildTowerStatusBoard(observations, checkedAt),
    });
  } catch (error) {
    if (error instanceof UnauthorizedPlatformAccessError) {
      res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
/** Human-invoked LEO planning only. Never writes, opens PRs, or calls a model. */
router.post("/platform/tower/pilot/repair-plan", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    await withPlatformContext(req.auth!.userId, async () => true);
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !["agentId", "signal"].includes(key)) ||
        typeof body.agentId !== "string" || typeof body.signal !== "string") {
      res.status(400).json({ error: "INVALID_REPAIR_SIGNAL" });
      return;
    }
    const plan = buildReadOnlyRepairPlan(body.agentId, body.signal);
    if (!plan) { res.status(400).json({ error: "REPAIR_PLAN_NOT_ALLOWED" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ plan, mode: "planning-only", executionEnabled: false });
  } catch (error) {
    if (error instanceof UnauthorizedPlatformAccessError) {
      res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
/** Human-requested preflight only; does not access GitHub or create a PR. */
router.post("/platform/tower/pilot/repair-pr-preflight", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    await withPlatformContext(req.auth!.userId, async () => true);
    const intent = validateRepairPrIntent(req.body);
    if (!intent) {
      res.status(400).json({ error: "INVALID_REPAIR_PR_INTENT" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ intent, mode: "dry-run", githubWriteEnabled: false, approvalRequired: true });
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
    const result = await reviewCorporateTask(req.auth!.userId, String(req.params.taskId), req.body);
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
router.get("/platform/tower/tasks/:taskId/audit", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const events = await listTaskAuditForAdmin(req.auth!.userId, String(req.params.taskId));
    res.setHeader("Cache-Control", "no-store");
    if (events === null) { res.status(404).json({ error: "TASK_NOT_FOUND" }); return; }
    res.json({ events });
  } catch (error) {
    if (error instanceof UnauthorizedPlatformAccessError) {
      res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
export default router;
