/** Which routes belong to a pilot feature (pure; used by orgFeatureGate). */
export type OrgFeature = "SMARTMATCH" | "EN_CAMINO" | "ACTIVITY_PHOTOS" | "FINANZAS" | "FACTURACION" | "SHIFT_REPORTS";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// 145: case-insensitive, like Express routing (a path with other capitals must not skip the gate).
const RULES: { pattern: RegExp; feature: OrgFeature; readableWhenOff?: boolean; passWhenOff?: string[] }[] = [
  { pattern: new RegExp(`^/organizations/(${UUID})/smartmatch(/|$)`, "i"), feature: "SMARTMATCH" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/private-instructions$`, "i"), feature: "SMARTMATCH" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/(journey|arrival)(/|$)`, "i"), feature: "EN_CAMINO" },
  { pattern: new RegExp(`^/organizations/(${UUID})/operations/journeys$`, "i"), feature: "EN_CAMINO" },
  { pattern: new RegExp(`^/organizations/(${UUID})/me/location-consent$`, "i"), feature: "EN_CAMINO" },
  // Activity photos (115/116): upload, review, image, consents.
  { pattern: new RegExp(`^/organizations/(${UUID})/care-events/${UUID}/photo(-eligibility)?$`, "i"), feature: "ACTIVITY_PHOTOS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/photo-eligibility$`, "i"), feature: "ACTIVITY_PHOTOS" },
  // 145 (§5): with the switch off, an ORGANIZATION_ADMIN keeps reviewing legal holds. These routes
  // pass the gate and the service + database decide (mode "legal-review": held photos only, no new holds).
  { pattern: new RegExp(`^/organizations/(${UUID})/activity-photos(/mode)?$`, "i"), feature: "ACTIVITY_PHOTOS", passWhenOff: ["GET"] },
  { pattern: new RegExp(`^/organizations/(${UUID})/activity-photos/${UUID}/(history|image)$`, "i"), feature: "ACTIVITY_PHOTOS", passWhenOff: ["GET"] },
  { pattern: new RegExp(`^/organizations/(${UUID})/activity-photos/${UUID}/legal-hold$`, "i"), feature: "ACTIVITY_PHOTOS", passWhenOff: ["POST"] },
  { pattern: new RegExp(`^/organizations/(${UUID})/activity-photos(/|$)`, "i"), feature: "ACTIVITY_PHOTOS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/care-recipients/${UUID}/photo-consents(/|$)`, "i"), feature: "ACTIVITY_PHOTOS" },
  // v2 (141): the relative's own authorization and the agency's list of recipients.
  { pattern: new RegExp(`^/organizations/(${UUID})/care-recipients/${UUID}/photo-(receipt|recipients)$`, "i"), feature: "ACTIVITY_PHOTOS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/photo-consents(/|$)`, "i"), feature: "ACTIVITY_PHOTOS" },
  // ETNARA Finanzas F1 (119): services, rates, clients, holidays, shift finance terms.
  { pattern: new RegExp(`^/organizations/(${UUID})/finance(/|$)`, "i"), feature: "FINANZAS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/finance$`, "i"), feature: "FINANZAS" },
  // Facturación Premium F2 (123): writes need FACTURACION (and FINANZAS, checked by the
  // service and the database). Reads pass the gate so issued history stays available in
  // read-only mode; who may read is decided by billing.view (service + RLS).
  { pattern: new RegExp(`^/organizations/(${UUID})/billing(/|$)`, "i"), feature: "FACTURACION", readableWhenOff: true },
  // Informe de Turno F1 (126): agency review and approval of shift reports.
  { pattern: new RegExp(`^/organizations/(${UUID})/shift-reports(/|$)`, "i"), feature: "SHIFT_REPORTS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shifts/${UUID}/shift-reports$`, "i"), feature: "SHIFT_REPORTS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/shift-report-(access|reviewers)(/|$)`, "i"), feature: "SHIFT_REPORTS" },
  // F2 (128): the caregiver reviews her own reports.
  { pattern: new RegExp(`^/organizations/(${UUID})/me/shift-reports(/|$)`, "i"), feature: "SHIFT_REPORTS" },
  // F3 (129): the family's approved reports of her resident.
  { pattern: new RegExp(`^/organizations/(${UUID})/care-recipients/${UUID}/shift-reports(/|$)`, "i"), feature: "SHIFT_REPORTS" },
];

/**
 * Express (strict routing off) serves `/x/` with the `/x` handler. The rules end in `$`, so
 * without this a trailing slash skipped the gate (auditoría 4-nov, I-2 residual). Every trailing slash is
 * stripped before matching (defensive); the request path itself is never rewritten.
 */
export function normalizeGatePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function gatedFeatureFor(path: string, method = "GET"): { organizationId: string; feature: OrgFeature; readOnlyPass?: boolean } | null {
  const normalized = normalizeGatePath(path);
  for (const rule of RULES) {
    const m = rule.pattern.exec(normalized);
    if (m) {
      const read = method === "GET" || method === "HEAD";
      const pass = (rule.readableWhenOff && read) || (rule.passWhenOff?.includes(method) ?? false);
      return { organizationId: m[1].toLowerCase(), feature: rule.feature, ...(pass ? { readOnlyPass: true } : {}) };
    }
  }
  return null;
}
