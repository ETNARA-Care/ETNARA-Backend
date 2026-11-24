import { sql } from "kysely";
import { Router, type Response } from "express";
import type { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";
import { withPlatformContext } from "../../context/tenantContext.js";
import { MODALITY_CODES, modalityActivationAllowed, setModalitySchema } from "./platformModalityRules.js";

/**
 * 163 · Interruptor de la modalidad «Cuidador independiente» en ETNARA Central.
 *
 * - Solo administración de plataforma (withPlatformContext + app_is_superadmin() en la base).
 * - Cada cambio exige motivo y queda en platform_modality_events (solo añadir), con valor anterior y nuevo.
 * - ENCENDER requiere además INDEPENDENT_MODALITY_ACTIVATION_ALLOWED=on en el servidor (ausente = no) y una
 *   autorización de activación vigente en la base de datos (de un solo uso, creada solo por operación). Apagar
 *   siempre está permitido.
 * - El interruptor gobierna solo el registro de nuevas organizaciones independientes; no toca las existentes.
 */
export class ModalityError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); this.name = "ModalityError"; }
}

const DB_ERRORS: Record<string, number> = {
  PLATFORM_ADMIN_REQUIRED: 403,
  MODALITY_REASON_REQUIRED: 400,
  MODALITY_STATE_REQUIRED: 400,
  MODALITY_NOT_FOUND: 404,
  MODALITY_ACTIVATION_LOCKED: 409,
};
function translate(err: unknown): never {
  const message = err instanceof Error ? err.message : "";
  const code = Object.keys(DB_ERRORS).find((c) => message.includes(c));
  if (code) throw new ModalityError(code, DB_ERRORS[code]);
  throw err;
}

type ModalityRow = { code: string; enabled: boolean; updated_at: string; updated_by_user_id: string | null; registered_organizations: number; activation_unlocked: boolean; activation_unlocked_until: string | null };

export async function listPlatformModalities(userId: string) {
  return withPlatformContext(userId, async (trx) => {
    const rows = await sql<ModalityRow>`SELECT * FROM public.app_platform_list_modalities()`.execute(trx).catch(translate);
    const events = await sql<{ modality_code: string; occurred_at: string; previous_enabled: boolean; new_enabled: boolean; reason: string; actor_email: string | null }>`
      SELECT e.modality_code, e.occurred_at, e.previous_enabled, e.new_enabled, e.reason, u.email AS actor_email
      FROM platform_modality_events e LEFT JOIN users u ON u.id = e.actor_user_id
      ORDER BY e.occurred_at DESC LIMIT 20`.execute(trx);
    const activationAllowed = modalityActivationAllowed();
    return {
      modalities: rows.rows.map((r) => ({
        code: r.code,
        enabled: r.enabled,
        updatedAt: r.updated_at,
        registeredOrganizations: r.registered_organizations,
        // Encender necesita las tres llaves: autorización vigente en la base, variable del servidor y Central.
        canEnable: !r.enabled && activationAllowed && r.activation_unlocked,
        databaseUnlocked: r.activation_unlocked,
        databaseUnlockedUntil: r.activation_unlocked_until,
        canDisable: r.enabled,
        activationAllowed,
        history: events.rows.filter((e) => e.modality_code === r.code).map((e) => ({
          occurredAt: e.occurred_at, previousEnabled: e.previous_enabled, newEnabled: e.new_enabled, reason: e.reason, actorEmail: e.actor_email,
        })),
      })),
    };
  });
}

export async function setPlatformModality(userId: string, code: string, input: z.infer<typeof setModalitySchema>) {
  if (!(MODALITY_CODES as readonly string[]).includes(code)) throw new ModalityError("MODALITY_NOT_FOUND", 404);
  // Encender necesita la autorización del servidor; apagar, nunca.
  if (input.enabled && !modalityActivationAllowed()) throw new ModalityError("MODALITY_ACTIVATION_NOT_AUTHORIZED", 409);
  return withPlatformContext(userId, async (trx) => {
    const r = await sql<{ code: string; enabled: boolean; updated_at: string; changed: boolean }>`
      SELECT * FROM public.app_platform_set_modality(${code}, ${input.enabled}, ${input.reason})`.execute(trx).catch(translate);
    const row = r.rows[0];
    return { modality: { code: row.code, enabled: row.enabled, updatedAt: row.updated_at }, changed: row.changed };
  });
}

function handle(err: unknown, res: Response) {
  if (err instanceof UnauthorizedPlatformAccessError) return void res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
  if (err instanceof ModalityError) return void res.status(err.status).json({ error: err.code });
  console.error("Unexpected platform modality failure", err instanceof Error ? { name: err.name } : {});
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

const router = Router();
router.get("/platform/modalities", requireAuth, async (req: AuthenticatedRequest, res) => {
  try { res.json(await listPlatformModalities(req.auth!.userId)); } catch (e) { handle(e, res); }
});
router.patch("/platform/modalities/:code", requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = setModalitySchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try { res.json(await setPlatformModality(req.auth!.userId, String(req.params.code), parsed.data)); } catch (e) { handle(e, res); }
});
export default router;
