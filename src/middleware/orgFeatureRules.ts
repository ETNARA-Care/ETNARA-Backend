/** Which routes belong to a pilot feature (pure; used by orgFeatureGate). */
export type OrgFeature = "SMARTMATCH" | "EN_CAMINO" | "ACTIVITY_PHOTOS" | "FINANZAS" | "FACTURACION" | "SHIFT_REPORTS";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const RULES: { pattern: RegExp; feature: OrgFeature; readableWhenOff?: boolean }[] = [
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
  // Facturación Premium F2 (123): writes need FACTURACION (and FINANZAS, checked by the
  // service and the database). Reads pass the gate so issued history stays available in
  // read-only mode; who may read is decided by billing.view (service + RLS).
  { pattern: new RegExp(`^/organizations/(${UUID})/billing(/|$)`), feature: "FACTURACION", readableWhenOff: true },
  // Informe de Turno F1 (124): agency review and approval of shift reports.
  { pattern: new RegExp(`^/organizations/(${UUID})/shift-reports(/|$)`), feature: "SHIFT_REPORTS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/shift-reports$`), feature: "SHIFT_REPORTS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shift-report-(access|reviewers)(/|$)`), feature: "SHIFT_REPORTS" },
];

export function gatedFeatureFor(path: string, method = "GET"): { organizationId: string; feature: OrgFeature; readOnlyPass?: boolean } | null {
  for (const rule of RULES) {
    const m = rule.pattern.exec(path);
    if (m) {
      const read = method === "GET" || method === "HEAD";
      return { organizationId: m[1].toLowerCase(), feature: rule.feature, ...(rule.readableWhenOff && read ? { readOnlyPass: true } : {}) };
    }
  }
  return null;
}
