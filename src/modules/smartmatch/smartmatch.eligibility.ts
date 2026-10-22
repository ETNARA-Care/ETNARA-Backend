/**
 * SmartMatch discovery gate. Eligibility is calculated server-side only.
 * A positive match requires explicit consent, verified eligibility, and a
 * route estimate from a routing provider (never straight-line distance).
 */
export interface SmartMatchEligibility {
  optedIn: boolean;
  credentialEligible: boolean;
  scheduleAvailable: boolean;
  activeNetworkMembership: boolean;
  sameOrganization: boolean;
  visibility: "INTERNAL" | "NETWORK";
  drivingMinutes: number | null;
  /** Caregiver-selected limit in minutes, defaults to 25; must be 10–60. */
  maxDrivingMinutes?: number;
}

export function isSmartMatchEligible(input: SmartMatchEligibility): boolean {
  if (!input.optedIn || !input.credentialEligible || !input.scheduleAvailable) return false;
  if (input.visibility === "INTERNAL" && !input.sameOrganization) return false;
  if (input.visibility === "NETWORK" && !input.sameOrganization && !input.activeNetworkMembership) return false;
  const minutes = input.drivingMinutes;
  const maximum = input.maxDrivingMinutes ?? 25;
  if (!Number.isInteger(maximum) || maximum < 10 || maximum > 60) return false;
  return minutes !== null && Number.isFinite(minutes) &&
    Number.isInteger(minutes) && minutes >= 0 && minutes <= maximum;
}
