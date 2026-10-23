import { isSmartMatchEligible, type SmartMatchEligibility } from "./smartmatch.eligibility.js";

/**
 * Pure SmartMatch candidate ordering. All candidates must already have been
 * fetched through a tenant-authorized, consent-aware query. Never use this
 * function as an authorization check or reveal candidate identities to clients.
 *
 * Prefer shortest verified driving time; stable opaque IDs break ties.
 * No patient, clinical or precise-coordinate information is accepted.
 */
export interface SmartMatchRankCandidate {
  opaqueCandidateId: string;
  eligibility: SmartMatchEligibility;
}

export interface SmartMatchRankResult {
  opaqueCandidateId: string;
  estimatedDriveMinutes: number;
}

export function rankSmartMatchCandidates(
  candidates: readonly SmartMatchRankCandidate[],
): SmartMatchRankResult[] {
  return candidates
    .filter(candidate => isSmartMatchEligible(candidate.eligibility))
    .map(candidate => ({
      opaqueCandidateId: candidate.opaqueCandidateId,
      estimatedDriveMinutes: candidate.eligibility.drivingMinutes as number,
    }))
    .sort((a, b) =>
      a.estimatedDriveMinutes - b.estimatedDriveMinutes ||
      (a.opaqueCandidateId < b.opaqueCandidateId ? -1 : a.opaqueCandidateId > b.opaqueCandidateId ? 1 : 0)
    );
}
