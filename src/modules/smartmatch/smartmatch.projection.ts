import { smartMatchOpportunitySummarySchema } from "./smartmatch.schemas.js";

export interface SmartMatchCandidate {
  id: string;
  regionLabel: string;
  startsAt: string;
  endsAt: string;
  roleLabel: string;
  estimatedDriveMinutes: number | null;
}

/**
 * Returns only an allowlisted discovery view. Do not pass through database
 * objects: those may contain tenant or care-recipient identifiers.
 * An unknown route is not an eligible 25-minute match.
 */
export function projectSmartMatchOpportunity(candidate: SmartMatchCandidate) {
  if (candidate.estimatedDriveMinutes === null) return null;
  if (!Number.isInteger(candidate.estimatedDriveMinutes)) return null;
  if (candidate.estimatedDriveMinutes < 0 || candidate.estimatedDriveMinutes > 25) return null;
  return smartMatchOpportunitySummarySchema.parse({
    id: candidate.id,
    regionLabel: candidate.regionLabel,
    startsAt: candidate.startsAt,
    endsAt: candidate.endsAt,
    roleLabel: candidate.roleLabel,
    estimatedDriveMinutes: candidate.estimatedDriveMinutes,
  });
}
