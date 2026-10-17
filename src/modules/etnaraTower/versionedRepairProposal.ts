import { validateRepairPatchProposal } from "./repairPatchGuard.js";
import { validateRepairFileVersions } from "./repairFileVersionGuard.js";

/** Combined validation of repair intent, exact allowed paths and expected Git blob SHAs.
 * No GitHub access, patch generation or writes occur here.
 */
export function validateVersionedRepairProposal(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "agentId,branch,files,repository,signal") return null;
  const files = validateRepairFileVersions(data.files);
  if (!files) return null;
  const patch = validateRepairPatchProposal({
    agentId: data.agentId, branch: data.branch, repository: data.repository,
    signal: data.signal, paths: files.map(file => file.path),
  });
  if (!patch) return null;
  return {
    repository: patch.repository, branch: patch.branch,
    files, dryRun: true as const, readyToApply: false as const,
    approvalRequired: true as const,
  };
}
