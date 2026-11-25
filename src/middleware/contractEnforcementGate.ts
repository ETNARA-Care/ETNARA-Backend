import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { withTenantContext } from "../context/tenantContext.js";
import { InvalidTenantContextError } from "../context/errors.js";
import { SessionInvalidError, validateSessionToken } from "../modules/auth/auth.service.js";
import { isTenantAccessDenied } from "../security/tenantAccessDenied.js";
import { canonicalGatePath, gatePathCandidates, respondGateUnavailable } from "./gatePath.js";
import { contractsEnforcementEnabled, decideContractGate, type EnforcementMode } from "../modules/contracts/contracts.enforcement.js";

/**
 * Puerta de acceso por contrato pendiente (153). APAGADA salvo CONTRACTS_ENFORCEMENT=on: apagada, no
 * hace ninguna consulta. Encendida, solo actúa sobre rutas de una agencia con modo y fecha fijados
 * por ETNARA Central. Sin sesión válida o sin pertenencia deja pasar: la ruta responde con sus propios permisos
 * (401/403); esta puerta nunca abre lo que la ruta cerraría.
 * Seguridad 25-nov: la ruta se compara en su forma canónica (ids codificados, mayúsculas, barra final), como la
 * enruta Express, y un fallo inesperado al decidir (base, permisos, función) cierra con 503 en vez de dejar pasar.
 * Las reglas de contrato (decideContractGate) no cambian.
 */
const ORG_PATH = /^\/organizations\/([0-9a-fA-F-]{36})(\/|$)/i;

export async function contractEnforcementGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!contractsEnforcementEnabled() || req.method === "OPTIONS") { next(); return; }
  const path = canonicalGatePath(req.path);
  const m = gatePathCandidates(req.path).map((p) => ORG_PATH.exec(p)).find((x) => x !== null) ?? null;
  const auth = req.headers.authorization ?? "";
  if (!m || !auth.startsWith("Bearer ")) { next(); return; }
  let userId: string;
  try {
    ({ userId } = await validateSessionToken(auth.slice("Bearer ".length).trim()));
  } catch (error) {
    if (error instanceof SessionInvalidError) { next(); return; }
    respondGateUnavailable(res, "contractEnforcementGate", "session", error, { error: "CONTRACT_CHECK_UNAVAILABLE" }); return;
  }
  try {
    const organizationId = m[1].toLowerCase();
    const state = await withTenantContext({ userId, organizationId }, async (trx) => {
      const s = (await sql<{ mode: EnforcementMode; enforce_from: Date | null; satisfied: boolean }>`SELECT mode, enforce_from, satisfied FROM public.app_contract_enforcement_state(${organizationId})`.execute(trx)).rows[0];
      const roles = (await sql<{ code: string }>`SELECT r.code FROM organization_memberships om JOIN user_roles ur ON ur.organization_membership_id = om.id
        JOIN roles r ON r.id = ur.role_id WHERE om.user_id = ${userId} AND om.organization_id = ${organizationId} AND om.status = 'active'`.execute(trx)).rows.map((r) => r.code);
      return { ...s, roles };
    });
    const d = decideContractGate({ mode: state.mode, enforceFrom: state.enforce_from ? new Date(state.enforce_from) : null, satisfied: state.satisfied, roles: state.roles, method: req.method, path, now: new Date() });
    if (!d.allow) { res.status(403).json({ error: d.reason, mode: d.mode }); return; }
  } catch (error) {
    // No miembro o id inválido: la ruta responde sus propios 403/400, como siempre.
    if (isTenantAccessDenied(error) || error instanceof InvalidTenantContextError) { next(); return; }
    respondGateUnavailable(res, "contractEnforcementGate", "check", error, { error: "CONTRACT_CHECK_UNAVAILABLE" }); return;
  }
  next();
}
