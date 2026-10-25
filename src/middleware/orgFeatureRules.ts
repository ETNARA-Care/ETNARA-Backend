/** Which routes belong to a pilot feature (pure; used by orgFeatureGate). */
export type OrgFeature = "SMARTMATCH" | "EN_CAMINO" | "ACTIVITY_PHOTOS" | "FINANZAS";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const RULES: { pattern: RegExp; feature: OrgFeature }[] = [
  { pattern: new RegExp(`^/organizations/(${UUID})/smartmatch(/|$)`), feature: "SMARTMATCH" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/private-instructions$`), feature: "SMARTMATCH" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/(journey|arrival)(/|$)`), feature: "EN_CAMINO" },
  { pattern: new RegExp(`^/organizations/(${UUID})/operations/journeys$`), feature: "EN_CAMINO" },
  { pattern: new RegExp(`^/organizations/(${UUID})/me/location-consent$`), feature: "EN_CAMINO" },
  // Activity photos (115/116): upload, review, image, consents.
  { pattern: new RegExp(`^/organizations/(${UUID})/care-events/${UUID}/photo(-eligibility)?$`), feature: "ACTIVITY_PHOTOS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/photo-eligibility$`), feature: "ACTIVITY_PHOTOS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/activity-photos(/|$)`), feature: "ACTIVITY_PHOTOS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/care-recipients/${UUID}/photo-consents(/|$)`), feature: "ACTIVITY_PHOTOS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/photo-consents(/|$)`), feature: "ACTIVITY_PHOTOS" },
  // ETNARA Finanzas F1 (119): services, rates, clients, holidays, shift finance terms.
  { pattern: new RegExp(`^/organizations/(${UUID})/finance(/|$)`), feature: "FINANZAS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/finance$`), feature: "FINANZAS" },
];

export function gatedFeatureFor(path: string): { organizationId: string; feature: OrgFeature } | null {
  for (const rule of RULES) {
    const m = rule.pattern.exec(path);
    if (m) return { organizationId: m[1].toLowerCase(), feature: rule.feature };
  }
  return null;
}
