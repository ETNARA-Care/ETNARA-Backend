import { validateRepairPrIntent, type RepairPrIntent } from "./repairPrPreflight.js";

/** Deterministic GitHub PR draft metadata. No API calls or writes. */
export interface RepairPrDraft {
  repository: RepairPrIntent["repository"];
  head: string;
  base: "main";
  title: string;
  body: string;
  readyToCreate: false;
  requiresHumanReview: true;
}
const descriptions = {
  frontend_unavailable: "Investigate frontend availability",
  database_unavailable: "Investigate database connectivity",
  backend_degraded: "Investigate backend degradation",
} as const;
export function prepareRepairPrDraft(input: unknown): RepairPrDraft | null {
  const intent = validateRepairPrIntent(input);
  if (!intent) return null;
  const title = "[Tower / LEO] " + descriptions[intent.signal];
  const body = [
    "## Repair investigation (draft only)",
    "Signal: " + intent.signal,
    "Prepared by: LEO (technology-2)",
    "Repository: " + intent.repository,
    "No code changes have been generated or tested.",
    "A platform administrator must review a concrete patch and CI evidence before creating or merging a PR.",
    "Patient records, secrets, and production deployments are out of scope.",
  ].join("\n\n");
  return { repository: intent.repository, head: intent.branch, base: "main",
    title, body, readyToCreate: false, requiresHumanReview: true };
}
