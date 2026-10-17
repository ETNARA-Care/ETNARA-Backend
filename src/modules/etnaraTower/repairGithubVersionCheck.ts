import { validateVersionedRepairProposal } from "./versionedRepairProposal.js";

/** Compare a preflight proposal with trusted GitHub file metadata retrieved separately.
 * Does not fetch GitHub data or perform writes. Caller must obtain current metadata
 * from the intended repository/ref using a trusted GitHub integration.
 */
export interface CurrentGithubFile {
  path: string;
  blobSha: string;
}
export type RepairVersionCheck =
  | { status: "match"; readyToApply: false; approvalRequired: true }
  | { status: "stale" | "invalid" | "incomplete"; readyToApply: false; approvalRequired: true };

export function compareRepairProposalToGithubMetadata(
  proposalInput: unknown,
  currentFilesInput: unknown,
): RepairVersionCheck {
  const blocked = (status: "stale" | "invalid" | "incomplete"): RepairVersionCheck =>
    ({ status, readyToApply: false, approvalRequired: true });
  const proposal = validateVersionedRepairProposal(proposalInput);
  if (!proposal || !Array.isArray(currentFilesInput)) return blocked("invalid");
  if (currentFilesInput.length !== proposal.files.length) return blocked("incomplete");
  const actual = new Map<string, string>();
  for (const value of currentFilesInput) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return blocked("invalid");
    const file = value as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "blobSha,path" ||
        typeof file.path !== "string" || typeof file.blobSha !== "string" ||
        !/^[a-f0-9]{40}$/.test(file.blobSha) || actual.has(file.path)) return blocked("invalid");
    actual.set(file.path, file.blobSha);
  }
  for (const file of proposal.files) {
    const sha = actual.get(file.path);
    if (!sha) return blocked("incomplete");
    if (sha !== file.expectedBlobSha) return blocked("stale");
  }
  return { status: "match", readyToApply: false, approvalRequired: true };
}
