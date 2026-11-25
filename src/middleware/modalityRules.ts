import { gatePathCandidates } from "./gatePath.js";
/**
 * 160 · Rutas de EQUIPO que no existen para un cuidador independiente (una sola persona con ADMIN + WORKER).
 * Puro: lo usa modalityGate. Solo se aplica a organizaciones INDEPENDENT_PROVIDER; agencias y hogares no pasan
 * por aquí con ningún efecto. La base de datos (160) mantiene además la regla de una sola persona operativa.
 */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ORG = `^/organizations/(${UUID})`;
const ALL = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

// Case-insensitive, como el enrutado de Express (misma lección que orgFeatureRules, 145).
const RULES: { pattern: RegExp; methods: string[] }[] = [
  { pattern: new RegExp(`${ORG}/team(/|$)`, "i"), methods: ALL },                                   // supervisoras, roles, invitaciones de personal
  { pattern: new RegExp(`${ORG}/workers$`, "i"), methods: WRITES },                                 // crear fichas de personal
  { pattern: new RegExp(`${ORG}/workers/${UUID}$`, "i"), methods: WRITES },                         // editar o dar de baja personal
  { pattern: new RegExp(`${ORG}/credentials/review-queue$`, "i"), methods: ALL },                   // cola de revisión de credenciales
  { pattern: new RegExp(`${ORG}/workers/${UUID}/credentials/${UUID}/review$`, "i"), methods: ALL }, // revisar credenciales
  { pattern: new RegExp(`${ORG}/smartmatch(/|$)`, "i"), methods: ALL },
  { pattern: new RegExp(`${ORG}/workforce(/|$)`, "i"), methods: ALL },                              // planificación de personal
  { pattern: new RegExp(`${ORG}/coverage(/|$)`, "i"), methods: ALL },                               // cobertura y su agente
  { pattern: new RegExp(`${ORG}/shifts/${UUID}/coverage-campaigns$`, "i"), methods: ALL },
  { pattern: new RegExp(`${ORG}/shifts/${UUID}/coverage-offers$`, "i"), methods: ALL },
  { pattern: new RegExp(`${ORG}/me/coverage-offers(/|$)`, "i"), methods: ALL },
  { pattern: new RegExp(`${ORG}/operations(/|$)`, "i"), methods: ALL },                             // centro operacional y agentes
  { pattern: new RegExp(`${ORG}/care-quality(/|$)`, "i"), methods: ALL },
  { pattern: new RegExp(`${ORG}/timesheets/${UUID}/review$`, "i"), methods: ALL },                  // aprobación de horas
  { pattern: new RegExp(`${ORG}/pay-periods(/|$)`, "i"), methods: ALL },
  { pattern: new RegExp(`${ORG}/financial-rates(/|$)`, "i"), methods: ALL },                        // tarifas de pago del personal
  { pattern: new RegExp(`${ORG}/establishments(/|$)`, "i"), methods: ALL },                         // establecimientos residenciales
  { pattern: new RegExp(`${ORG}/my-admin-establishments$`, "i"), methods: ALL },
  // PR B (Mi práctica): vistas del centro de cumplimiento de agencia (auditoría y agente sobre el personal) y la
  // conversación «con mi agencia», que en un independiente sería consigo misma. La configuración de requisitos
  // propia (compliance/configuration) y el resumen de la propia ficha (workers/:id/compliance) siguen abiertos (PR C).
  { pattern: new RegExp(`${ORG}/compliance/audit$`, "i"), methods: ALL },
  { pattern: new RegExp(`${ORG}/compliance/agent(/|$)`, "i"), methods: ALL },
  { pattern: new RegExp(`${ORG}/my-agency-conversation$`, "i"), methods: ALL },
];

/** Devuelve la organización si la ruta es de equipo y está cerrada para un independiente; null en otro caso. */
export function teamRouteFor(path: string, method = "GET"): { organizationId: string } | null {
  const m = method.toUpperCase();
  // Seguridad 25-nov: también la forma canónica (ids codificados, barra final), como la entiende Express.
  for (const candidate of gatePathCandidates(path)) for (const rule of RULES) {
    const match = rule.pattern.exec(candidate);
    if (match && rule.methods.includes(m)) return { organizationId: match[1].toLowerCase() };
  }
  return null;
}
