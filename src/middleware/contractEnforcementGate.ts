import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { withTenantContext } from "../context/tenantContext.js";
import { validateSessionToken } from "../modules/auth/auth.service.js";
import { contractsEnforcementEnabled, decideContractGate, type EnforcementMode } from "../modules/contracts/contracts.enforcement.js";

/**
 * Puerta de acceso por contrato pendiente (153). APAGADA salvo CONTRACTS_ENFORCEMENT=on: apagada, no
 * hace ninguna consulta. Encendida, solo actúa sobre rutas de una agencia con modo y fecha fijados
 * por ETNARA Central. Ante cualquier duda (sin sesión, no miembro, error) deja pasar: la ruta
 * responde con sus propios permisos; esta puerta nunca abre lo que la ruta cerraría.
 */
const ORG_PATH = /^\/organizations\/([0-9a-fA-F-]{36})(\/|$)/;

export async function contractEnforcementGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!contractsEnforcementEnabled() || req.method === "OPTIONS") { next(); return; }
  const m = ORG_PATH.exec(req.path);
  const auth = req.headers.authorization ?? "";
  if (!m || !auth.startsWith("Bearer ")) { next(); return; }
  try {
    const { userId } = await validateSessionToken(auth.slice("Bearer ".length).trim());
    const organizationId = m[1];
    const state = await withTenantContext({ userId, organizationId }, async (trx) => {
      const s = (await sql<{ mode: EnforcementMode; enforce_from: Date | null; satisfied: boolean }>`SELECT mode, enforce_from, satisfied FROM public.app_contract_enforcement_state(${organizationId})`.execute(trx)).rows[0];
      const roles = (await sql<{ code: string }>`SELECT r.code FROM organization_memberships om JOIN user_roles ur ON ur.organization_membership_id = om.id
        JOIN roles r ON r.id = ur.role_id WHERE om.user_id = ${userId} AND om.organization_id = ${organizationId} AND om.status = 'active'`.execute(trx)).rows.map((r) => r.code);
      return { ...s, roles };
    });
    const d = decideContractGate({ mode: state.mode, enforceFrom: state.enforce_from ? new Date(state.enforce_from) : null, satisfied: state.satisfied, roles: state.roles, method: req.method, path: req.path, now: new Date() });
    if (!d.allow) { res.status(403).json({ error: d.reason, mode: d.mode }); return; }
  } catch { /* la ruta decide */ }
  next();
}
