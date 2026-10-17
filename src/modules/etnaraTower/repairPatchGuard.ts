import { validateRepairPrIntent } from "./repairPrPreflight.js";

/** Strictly inspect proposed patch metadata; no filesystem or GitHub writes. */
const allowedFiles: Readonly<Record<string, readonly string[]>> = {
  "ETNARA-Care/ETNARA-Backend": [
    "src/modules/etnaraTower/liveHealthCollector.ts",
    "src/modules/etnaraTower/tower.routes.ts",
  ],
  "ETNARA-Care/ETNARAMVP": [
    "frontend-v23/src/pages/platform/PlatformTowerPage.tsx",
  ],
};
export interface RepairPatchPreflight {
  accepted: true;
  repository: string;
  branch: string;
  paths: readonly string[];
  readyToApply: false;
  approvalRequired: true;
}
export function validateRepairPatchProposal(input: unknown): RepairPatchPreflight | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "agentId,branch,paths,repository,signal") return null;
  const intent = validateRepairPrIntent({
    agentId: data.agentId, branch: data.branch, repository: data.repository, signal: data.signal,
  });
  if (!intent || !Array.isArray(data.paths) || data.paths.length < 1 || data.paths.length > 3) return null;
  const allowed = allowedFiles[intent.repository];
  if (!allowed || !data.paths.every(path => typeof path === "string" && allowed.includes(path))) return null;
  if (new Set(data.paths).size !== data.paths.length) return null;
  return { accepted: true, repository: intent.repository, branch: intent.branch,
    paths: [...data.paths] as string[], readyToApply: false, approvalRequired: true };
}
