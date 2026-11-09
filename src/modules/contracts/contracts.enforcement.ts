/**
 * Reglas de acceso por contrato pendiente (153) — PREPARADAS Y APAGADAS.
 * Sin CONTRACTS_ENFORCEMENT=on el servidor no consulta nada y deja pasar todo.
 *
 * Modos por agencia (los fija ETNARA Central, con fecha de inicio):
 *   off                      nada.
 *   notice                   solo aviso en el portal (transición).
 *   restrict_new_operations  agencias que ya operan: se bloquea solo ABRIR operación nueva (crear turnos,
 *                            residentes, establecimientos, personal, invitaciones, oportunidades, facturas).
 *                            Lecturas, turnos ya creados y en curso, registros, incidentes y mensajes siguen.
 *   contract_only            agencias nuevas SIN datos: la administración solo completa el contrato
 *                            (lecturas permitidas; cualquier escritura fuera de /contracts se rechaza).
 * Nunca afecta a cuidadores ni familiares (sus sesiones no cambian) ni a ETNARA Central.
 */
export type EnforcementMode = "off" | "notice" | "restrict_new_operations" | "contract_only";
export const contractsEnforcementEnabled = () => process.env.CONTRACTS_ENFORCEMENT === "on";

const ORG = "/organizations/[^/]+";
/** Abrir operación nueva (solo POST). */
const NEW_OPERATIONS: RegExp[] = [
  `${ORG}/shifts`, `${ORG}/establishments/[^/]+/shifts`, `${ORG}/care-recipients`, `${ORG}/establishments`,
  `${ORG}/establishments/[^/]+/residents`, `${ORG}/workers`, `${ORG}/access-invitations`, `${ORG}/team/invitations`,
  `${ORG}/smartmatch/opportunities`, `${ORG}/smartmatch/opportunities/[^/]+/publish`, `${ORG}/billing/invoices`,
  `${ORG}/billing/invoices/[^/]+/issue`,
].map((p) => new RegExp(`^${p}/?$`));
/** Siempre permitido: el propio proceso contractual. */
const CONTRACT_PATHS = new RegExp(`^${ORG}/contracts(/|$)`);

export interface GateInput {
  mode: EnforcementMode; enforceFrom: Date | null; satisfied: boolean;
  roles: string[]; method: string; path: string; now: Date;
}
export type GateDecision = { allow: true } | { allow: false; reason: "CONTRACT_ACCEPTANCE_REQUIRED"; mode: EnforcementMode };

export function decideContractGate(i: GateInput): GateDecision {
  if (i.satisfied || i.mode === "off" || i.mode === "notice") return { allow: true };
  if (!i.enforceFrom || i.now < i.enforceFrom) return { allow: true };
  // Solo la gestión de la agencia; cuidadores y familiares nunca.
  if (!i.roles.some((r) => r === "ORGANIZATION_ADMIN" || r === "SUPERVISOR")) return { allow: true };
  if (CONTRACT_PATHS.test(i.path)) return { allow: true };
  const method = i.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { allow: true }; // acceso a los datos
  if (i.mode === "restrict_new_operations") {
    return method === "POST" && NEW_OPERATIONS.some((re) => re.test(i.path)) ? { allow: false, reason: "CONTRACT_ACCEPTANCE_REQUIRED", mode: i.mode } : { allow: true };
  }
  return { allow: false, reason: "CONTRACT_ACCEPTANCE_REQUIRED", mode: i.mode }; // contract_only
}

/** Días mínimos de aviso para agencias que ya operan (transición aprobada). */
export const MIN_NOTICE_DAYS = 30;
