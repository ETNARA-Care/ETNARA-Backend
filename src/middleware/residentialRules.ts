/**
 * 170 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F0. Puro: lo usa residentialGate.
 *
 * Dos clases de ruta:
 *   - "residential": /organizations/:id/residential/* existe SOLO para hogares (D1). Agencias e independientes
 *     reciben 403 MODALITY_NOT_AVAILABLE.
 *   - "denied": módulos que no existen para un hogar (plan §2 y D10): Finanzas, Facturación, SmartMatch e
 *     Informe de Turno. Solo se cierran cuando la organización ES un hogar; agencias e independientes siguen
 *     exactamente igual (sus interruptores de 108/157 deciden, como hoy).
 */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ORG = `^/organizations/(${UUID})`;

export type ResidentialRouteKind = "residential" | "denied";

// Revisión independiente 25-nov (A1). Se compara con la ruta tal como la entiende Express 5 (router 2 /
// path-to-regexp 8): sin distinguir mayúsculas, con barra final opcional y con los parámetros DECODIFICADOS
// (/organizations/%61bc…/finance llega a la ruta con el id «abc…»). Por eso cada regla termina en (/|$) y se
// prueba contra la ruta original y contra su forma canónica (segmentos decodificados, barras repetidas y finales
// quitadas). Reconocer de más solo puede cerrar una petición, nunca abrirla.
const RULES: { pattern: RegExp; kind: ResidentialRouteKind }[] = [
  { pattern: new RegExp(`${ORG}/residential(/|$)`, "i"), kind: "residential" },
  // Finanzas (119) y Facturación (123).
  { pattern: new RegExp(`${ORG}/finance(/|$)`, "i"), kind: "denied" },
  { pattern: new RegExp(`${ORG}/shifts/${UUID}/finance(/|$)`, "i"), kind: "denied" },
  { pattern: new RegExp(`${ORG}/billing(/|$)`, "i"), kind: "denied" },
  // SmartMatch (090–093) e instrucciones privadas asociadas.
  { pattern: new RegExp(`${ORG}/smartmatch(/|$)`, "i"), kind: "denied" },
  { pattern: new RegExp(`${ORG}/shifts/${UUID}/private-instructions(/|$)`, "i"), kind: "denied" },
  // Informe de Turno (126–129), D10.
  { pattern: new RegExp(`${ORG}/shift-reports(/|$)`, "i"), kind: "denied" },
  { pattern: new RegExp(`${ORG}/shifts/${UUID}/shift-reports(/|$)`, "i"), kind: "denied" },
  { pattern: new RegExp(`${ORG}/shift-report-(access|reviewers)(/|$)`, "i"), kind: "denied" },
  { pattern: new RegExp(`${ORG}/me/shift-reports(/|$)`, "i"), kind: "denied" },
  { pattern: new RegExp(`${ORG}/care-recipients/${UUID}/shift-reports(/|$)`, "i"), kind: "denied" },
];

/**
 * Forma canónica de una ruta para la guarda: cada segmento decodificado (si un segmento no se puede decodificar se
 * deja tal cual), barras repetidas reducidas a una y sin barra final. Nunca lanza.
 */
export function canonicalGatePath(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "").map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  return "/" + segments.join("/");
}

/** Todos los métodos: la regla es por modalidad, no por lectura o escritura. */
export function residentialRouteFor(path: string): { organizationId: string; kind: ResidentialRouteKind } | null {
  const canonical = canonicalGatePath(path);
  for (const candidate of canonical === path ? [path] : [canonical, path]) {
    for (const rule of RULES) {
      const match = rule.pattern.exec(candidate);
      if (match) return { organizationId: match[1].toLowerCase(), kind: rule.kind };
    }
  }
  return null;
}

/** Interruptores por organización exclusivos de hogares (170). */
export const RESIDENTIAL_ONLY_FEATURES = ["HOGAR_CALENDARIO", "HOGAR_ASIGNACIONES", "HOGAR_PONCHES", "DEMO_ENVIRONMENT"] as const;
/** Interruptores que no existen para un hogar (170, D10). */
export const RESIDENTIAL_DENIED_FEATURES = ["SMARTMATCH", "FINANZAS", "FACTURACION", "SHIFT_REPORTS"] as const;

/** Qué códigos de interruptor ve ETNARA central para una organización según su tipo. Agencias: lista de siempre. */
export function featureCodesForOrganizationType<T extends string>(allCodes: readonly T[], organizationType: string): T[] {
  const residentialOnly = RESIDENTIAL_ONLY_FEATURES as readonly string[];
  const denied = RESIDENTIAL_DENIED_FEATURES as readonly string[];
  if (organizationType === "RESIDENTIAL_CARE_HOME") return allCodes.filter((c) => !denied.includes(c));
  return allCodes.filter((c) => !residentialOnly.includes(c));
}
