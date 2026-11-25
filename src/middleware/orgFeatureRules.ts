import { gatePathCandidates } from "./gatePath.js";
/** Which routes belong to a pilot feature (pure; used by orgFeatureGate). */
export type OrgFeature = "SMARTMATCH" | "EN_CAMINO" | "ACTIVITY_PHOTOS" | "FINANZAS" | "FACTURACION" | "SHIFT_REPORTS" | "CONTRACTS";

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
  // Contratos por agencia (157): contrato, constancias, Word, firma y términos por función. Se suma a
  // CONTRACTS_MODULE (global): con el módulo apagado las rutas siguen respondiendo 404.
  // Con el interruptor apagado, SOLO LECTURA de las aceptaciones ya hechas: el historial y la constancia
  // PDF de cada una (y el historial propio de términos). Quién puede leerlas lo deciden el servicio
  // (administración activa de esa agencia) y RLS; cada descarga de constancia queda auditada.
  { pattern: new RegExp(`^/organizations/(${UUID})/contracts/acceptances$`, "i"), feature: "CONTRACTS", passWhenOff: ["GET"] },
  { pattern: new RegExp(`^/organizations/(${UUID})/contracts/acceptances/${UUID}/certificate\\.pdf$`, "i"), feature: "CONTRACTS", passWhenOff: ["GET"] },
  { pattern: new RegExp(`^/organizations/(${UUID})/role-terms/acceptances$`, "i"), feature: "CONTRACTS", passWhenOff: ["GET"] },
  { pattern: new RegExp(`^/organizations/(${UUID})/contracts(/|$)`, "i"), feature: "CONTRACTS" },
  { pattern: new RegExp(`^/organizations/(${UUID})/role-terms(/|$)`, "i"), feature: "CONTRACTS" },
];

export function gatedFeatureFor(path: string, method = "GET"): { organizationId: string; feature: OrgFeature; readOnlyPass?: boolean } | null {
  // Seguridad 25-nov: también la forma canónica (ids codificados, barra final), como la entiende Express.
  for (const candidate of gatePathCandidates(path)) for (const rule of RULES) {
    const m = rule.pattern.exec(candidate);
    if (m) {
      const read = method === "GET" || method === "HEAD";
      // HEAD es un GET sin cuerpo (Express lo atiende con la ruta GET): lo que se permite en GET se permite en HEAD.
      const pass = (rule.readableWhenOff && read) || (rule.passWhenOff?.includes(method === "HEAD" ? "GET" : method) ?? false);
      return { organizationId: m[1].toLowerCase(), feature: rule.feature, ...(pass ? { readOnlyPass: true } : {}) };
    }
  }
  return null;
}
