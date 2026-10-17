import { validateVersionedRepairProposal } from "./versionedRepairProposal.js";
import { compareRepairProposalToGithubMetadata } from "./repairGithubVersionCheck.js";
import { fetchRepairGithubBlobMetadata } from "./repairGithubReadOnly.js";

/** Read-only orchestration for admin-authorized LEO repair version preflight.
 * Token must come from server configuration; never return it to clients.
 */
export async function runRepairGithubVersionPreflight(
  input: unknown,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  const proposal = validateVersionedRepairProposal(input);
  if (!proposal) return { status: "invalid" as const, readyToApply: false as const };
  const result = await fetchRepairGithubBlobMetadata(
    proposal.repository, proposal.files.map(file => file.path), token, fetcher,
  );
  if (result.status !== "ok") return { status: result.status, readyToApply: false as const };
  const comparison = compareRepairProposalToGithubMetadata(input, result.files);
  return { status: comparison.status, readyToApply: false as const,
    approvalRequired: true as const, githubWriteEnabled: false as const };
}
