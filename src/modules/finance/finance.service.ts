import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { AGENCY_TIME_ZONE, recordFinanceEvent, recordFinancialAudit } from "./financeEvents.js";
import { computeCharge, grossMargin, type FinanceUnit, type HalfDayPolicy } from "./financeCalc.js";

/**
 * ETNARA Finanzas F1 — services, billing and pay rates, clients, holidays and
 * the finance terms of a shift. ORGANIZATION_ADMIN only, FINANZAS on only
 * (route gate + database policies). Values are written to finance_events;
 * audit_log only gets identifiers.
 */

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

export class FinanceError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = "FinanceError";
  }
}

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const serviceCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: optionalText(500),
  unit: z.enum(["hour", "shift", "day", "fixed"]),
});
export const serviceUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: optionalText(500),
  active: z.boolean().optional(),
}).refine((v) => v.name !== undefined || v.description !== undefined || v.active !== undefined, { message: "EMPTY_UPDATE" });

export const rateCreateSchema = z.object({
  rateKind: z.enum(["client", "caregiver"]),
  scope: z.enum(["general", "client", "caregiver"]).default("general"),
  billingClientId: uuid.optional().nullable(),
  membershipId: uuid.optional().nullable(),
  dayType: z.enum(["standard", "holiday"]).default("standard"),
  amountCents: z.number().int().min(0).max(1000000),
  effectiveFrom: isoDate.optional(),
  minMinutes: z.number().int().min(1).max(1440).optional().nullable(),
  roundingMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]).optional().nullable(),
  halfDayPolicy: z.enum(["review", "proportional", "fixed"]).optional().nullable(),
  halfDayAmountCents: z.number().int().min(0).max(1000000).optional().nullable(),
  reason: z.string().trim().min(3).max(300).optional(),
});
export const rateEndSchema = z.object({ effectiveTo: isoDate, reason: z.string().trim().min(3).max(300) });
export const rateCancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });
export const holidayDeactivateSchema = z.object({ reason: z.string().trim().min(3).max(300) });
export const holidayDateSchema = isoDate;

export const clientSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  phone: optionalText(40),
  address: optionalText(300),
  notes: optionalText(1000),
});
export const clientUpdateSchema = clientSchema.partial().extend({ active: z.boolean().optional() });
export const clientRecipientSchema = z.object({ careRecipientId: uuid, isPrimary: z.boolean().default(true) });
export const holidaySchema = z.object({ date: isoDate, name: z.string().trim().min(2).max(80) });
export const recipientDefaultsSchema = z.object({ serviceId: uuid.nullable() });
export const shiftTermsSchema = z.object({
  serviceId: uuid.nullable(),
  billingClientId: uuid.nullable().optional(),
  authorizedUnitsHundredths: z.number().int().min(1).max(100000).nullable().optional(),
  note: optionalText(500),
});
export const resolveSchema = z.object({
  serviceId: uuid,
  date: isoDate.optional(),
  billingClientId: uuid.optional(),
  membershipId: uuid.optional(),
  minutes: z.coerce.number().int().min(0).max(2880 * 31).optional(),
});

// ---------------------------------------------------------------------------
// Context

async function assertFinanceAdmin(trx: Trx, organizationId: string): Promise<void> {
  const r = await sql<{ admin: boolean; enabled: boolean }>`
    SELECT app_is_org_admin() AS admin, app_org_feature_enabled(${organizationId}::uuid, 'FINANZAS') AS enabled
  `.execute(trx);
  if (!r.rows[0]?.enabled) throw new FinanceError("FEATURE_NOT_ENABLED", 404);
  if (!r.rows[0]?.admin) throw new FinanceError("FINANCE_FORBIDDEN", 403);
}

function inFinance<T>(userId: string, organizationId: string, work: (trx: Trx) => Promise<T>): Promise<T> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertFinanceAdmin(trx, organizationId);
    return work(trx);
  });
}

async function todayPR(trx: Trx): Promise<string> {
  const r = await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${AGENCY_TIME_ZONE})::date, 'YYYY-MM-DD') AS d`.execute(trx);
  return r.rows[0].d;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Database guard messages become stable API codes; everything else is rethrown. */
function mapDbError(error: unknown): never {
  const e = error as { code?: string; message?: string };
  const known = ["FINANCE_RATE_OVERLAP", "FINANCE_RATE_IMMUTABLE", "FINANCE_RATE_END_ONLY_EARLIER", "FINANCE_RATE_RULE_NOT_FOR_UNIT",
    "FINANCE_SERVICE_UNIT_IMMUTABLE", "SHIFT_FINANCE_LOCKED", "FINANCE_SERVICE_NOT_FOUND",
    "FINANCE_RATE_CANCELLED", "FINANCE_RATE_ALREADY_IN_FORCE", "FINANCE_RATE_REOPEN_INVALID",
    "FINANCE_HOLIDAY_IMMUTABLE", "FINANCE_HOLIDAY_NO_DELETE"];
  const hit = known.find((k) => e?.message?.includes(k));
  if (hit) throw new FinanceError(hit, hit === "FINANCE_SERVICE_NOT_FOUND" ? 404 : 409);
  if (e?.code === "23505") throw new FinanceError("FINANCE_DUPLICATE", 409);
  // A well-formed but impossible date (2026-13-45) is the caller's error, not a 500.
  if (e?.code === "22007" || e?.code === "22008") throw new FinanceError("INVALID_DATE", 400);
  if (e?.code === "23503") throw new FinanceError("FINANCE_REFERENCE_NOT_FOUND", 404);
  if (e?.code === "42501") throw new FinanceError("FINANCE_FORBIDDEN", 403);
  // Safety net: two administrators changing the same prices at the same instant.
  if (e?.code === "40P01" || e?.code === "40001") throw new FinanceError("FINANCE_CONCURRENT_CHANGE", 409);
  throw error;
}

/**
 * Every price change of a service takes the service row lock FIRST (createRate
 * does), then the rate row. Taking them in the other order deadlocks against a
 * concurrent createRate on the same service.
 */
async function lockServiceOfRate(trx: Trx, organizationId: string, rateId: string): Promise<boolean> {
  const r = await sql<{ service_id: string }>`SELECT service_id FROM finance_rates WHERE id = ${rateId} AND organization_id = ${organizationId}`.execute(trx);
  if (!r.rows[0]) return false;
  await sql`SELECT 1 FROM finance_services WHERE id = ${r.rows[0].service_id} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx);
  return true;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { if (error instanceof FinanceError) throw error; return mapDbError(error); }
}

// ---------------------------------------------------------------------------
// Services

export interface CurrentRate { amount_cents: number; effective_from: string; effective_to: string | null }

export async function listServices(userId: string, organizationId: string) {
  return inFinance(userId, organizationId, async (trx) => {
    const today = await todayPR(trx);
    const rows = await sql<{
      id: string; name: string; description: string | null; unit: FinanceUnit; active: boolean; updated_at: string;
      client_cents: number | null; caregiver_cents: number | null; client_exceptions: number; caregiver_exceptions: number;
      next_change: string | null;
    }>`
      SELECT s.id, s.name, s.description, s.unit, s.active, s.updated_at,
        (SELECT r.amount_cents FROM finance_rates r WHERE r.cancelled_at IS NULL AND r.service_id = s.id AND r.rate_kind = 'client' AND r.scope = 'general'
           AND r.day_type = 'standard' AND r.effective_from <= ${today}::date AND (r.effective_to IS NULL OR r.effective_to >= ${today}::date)) AS client_cents,
        (SELECT r.amount_cents FROM finance_rates r WHERE r.cancelled_at IS NULL AND r.service_id = s.id AND r.rate_kind = 'caregiver' AND r.scope = 'general'
           AND r.day_type = 'standard' AND r.effective_from <= ${today}::date AND (r.effective_to IS NULL OR r.effective_to >= ${today}::date)) AS caregiver_cents,
        (SELECT count(*)::int FROM finance_rates r WHERE r.cancelled_at IS NULL AND r.service_id = s.id AND r.scope = 'client'
           AND (r.effective_to IS NULL OR r.effective_to >= ${today}::date)) AS client_exceptions,
        (SELECT count(*)::int FROM finance_rates r WHERE r.cancelled_at IS NULL AND r.service_id = s.id AND r.scope = 'caregiver'
           AND (r.effective_to IS NULL OR r.effective_to >= ${today}::date)) AS caregiver_exceptions,
        (SELECT to_char(min(r.effective_from), 'YYYY-MM-DD') FROM finance_rates r WHERE r.cancelled_at IS NULL AND r.service_id = s.id AND r.effective_from > ${today}::date) AS next_change
      FROM finance_services s
      WHERE s.organization_id = ${organizationId}
      ORDER BY s.active DESC, lower(s.name)
    `.execute(trx);
    return {
      today,
      services: rows.rows.map((s) => ({
        ...s,
        margin: s.client_cents != null && s.caregiver_cents != null ? grossMargin(s.client_cents, s.caregiver_cents) : null,
      })),
    };
  });
}

export async function createService(userId: string, organizationId: string, input: z.infer<typeof serviceCreateSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    const r = await sql<{ id: string }>`
      INSERT INTO finance_services (organization_id, name, description, unit, created_by_user_id, updated_by_user_id)
      VALUES (${organizationId}, ${input.name}, ${input.description}, ${input.unit}, ${userId}, ${userId})
      RETURNING *
    `.execute(trx);
    const service = r.rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_SERVICE_CREATED", entityType: "finance_service", entityId: service.id, newValue: service });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_SERVICE_CREATED", entityType: "finance_service", entityId: service.id });
    return service;
  }));
}

export async function updateService(userId: string, organizationId: string, serviceId: string, input: z.infer<typeof serviceUpdateSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    const before = (await sql<Record<string, unknown>>`SELECT * FROM finance_services WHERE id = ${serviceId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
    if (!before) throw new FinanceError("FINANCE_SERVICE_NOT_FOUND", 404);
    const after = (await sql<Record<string, unknown>>`
      UPDATE finance_services SET
        name = COALESCE(${input.name ?? null}, name),
        description = CASE WHEN ${input.description === undefined} THEN description ELSE ${input.description ?? null} END,
        active = COALESCE(${input.active ?? null}::boolean, active),
        updated_by_user_id = ${userId}, updated_at = now()
      WHERE id = ${serviceId} AND organization_id = ${organizationId}
      RETURNING *
    `.execute(trx)).rows[0];
    const action = input.active === false && before.active ? "FINANCE_SERVICE_DEACTIVATED"
      : input.active === true && !before.active ? "FINANCE_SERVICE_ACTIVATED" : "FINANCE_SERVICE_UPDATED";
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action, entityType: "finance_service", entityId: serviceId, previousValue: before, newValue: after });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action, entityType: "finance_service", entityId: serviceId });
    return after;
  }));
}

// ---------------------------------------------------------------------------
// Rates

export async function listRates(userId: string, organizationId: string, serviceId: string) {
  return inFinance(userId, organizationId, async (trx) => {
    const service = (await sql<{ id: string; name: string; unit: FinanceUnit; active: boolean }>`
      SELECT id, name, unit, active FROM finance_services WHERE id = ${serviceId} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
    if (!service) throw new FinanceError("FINANCE_SERVICE_NOT_FOUND", 404);
    const today = await todayPR(trx);
    const rates = await sql`
      SELECT r.id, r.rate_kind, r.scope, r.day_type, r.amount_cents, r.currency,
        to_char(r.effective_from, 'YYYY-MM-DD') AS effective_from, to_char(r.effective_to, 'YYYY-MM-DD') AS effective_to,
        r.min_minutes, r.rounding_minutes, r.half_day_policy, r.half_day_amount_cents, r.reason, r.end_reason,
        r.created_at, r.ended_at, r.cancelled_at, r.cancel_reason, xu.email AS cancelled_by_email,
        r.billing_client_id, c.full_name AS client_name,
        r.organization_worker_membership_id AS membership_id, w.display_name AS caregiver_name,
        cu.email AS created_by_email,
        CASE WHEN r.cancelled_at IS NOT NULL THEN 'cancelled'
             WHEN r.effective_from > ${today}::date THEN 'future'
             WHEN r.effective_to IS NOT NULL AND r.effective_to < ${today}::date THEN 'past'
             ELSE 'current' END AS status
      FROM finance_rates r
      LEFT JOIN billing_clients c ON c.id = r.billing_client_id
      LEFT JOIN organization_worker_memberships m ON m.id = r.organization_worker_membership_id
      LEFT JOIN workers w ON w.id = m.worker_id
      LEFT JOIN users cu ON cu.id = r.created_by_user_id
      LEFT JOIN users xu ON xu.id = r.cancelled_by_user_id
      WHERE r.service_id = ${serviceId} AND r.organization_id = ${organizationId}
      ORDER BY r.rate_kind, r.scope, c.full_name NULLS FIRST, w.display_name NULLS FIRST, r.day_type, r.effective_from DESC
    `.execute(trx);
    const history = await sql`
      SELECT e.action, e.occurred_at, e.previous_value, e.new_value, u.email AS actor_email
      FROM finance_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.organization_id = ${organizationId}
        AND ((e.entity_type = 'finance_service' AND e.entity_id = ${serviceId})
          OR (e.entity_type = 'finance_rate' AND e.new_value->>'service_id' = ${serviceId}))
      ORDER BY e.occurred_at DESC
      LIMIT 200
    `.execute(trx);
    return { today, service, rates: rates.rows, history: history.rows };
  });
}

export async function createRate(userId: string, organizationId: string, serviceId: string, input: z.infer<typeof rateCreateSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    // Serialises every price change of this service.
    const service = (await sql<{ id: string; unit: FinanceUnit; active: boolean }>`
      SELECT id, unit, active FROM finance_services WHERE id = ${serviceId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
    if (!service) throw new FinanceError("FINANCE_SERVICE_NOT_FOUND", 404);
    if (!service.active) throw new FinanceError("FINANCE_SERVICE_INACTIVE", 409);

    const scope = input.scope;
    const clientId = scope === "client" ? input.billingClientId ?? null : null;
    const membershipId = scope === "caregiver" ? input.membershipId ?? null : null;
    if (scope === "client" && (input.rateKind !== "client" || !clientId)) throw new FinanceError("FINANCE_RATE_SCOPE_INVALID", 400);
    if (scope === "caregiver" && (input.rateKind !== "caregiver" || !membershipId)) throw new FinanceError("FINANCE_RATE_SCOPE_INVALID", 400);
    if (scope === "general" && (input.billingClientId || input.membershipId)) throw new FinanceError("FINANCE_RATE_SCOPE_INVALID", 400);
    if (service.unit !== "hour" && (input.minMinutes || input.roundingMinutes)) throw new FinanceError("FINANCE_RATE_RULE_NOT_FOR_UNIT", 400);
    if (service.unit !== "day" && input.halfDayPolicy) throw new FinanceError("FINANCE_RATE_RULE_NOT_FOR_UNIT", 400);
    if ((input.halfDayPolicy === "fixed") !== (input.halfDayAmountCents != null)) throw new FinanceError("FINANCE_HALF_DAY_AMOUNT_REQUIRED", 400);
    if (clientId) {
      const ok = await sql`SELECT 1 FROM billing_clients WHERE id = ${clientId} AND organization_id = ${organizationId} AND active`.execute(trx);
      if (!ok.rows[0]) throw new FinanceError("FINANCE_CLIENT_NOT_FOUND", 404);
    }
    if (membershipId) {
      const ok = await sql`SELECT 1 FROM organization_worker_memberships WHERE id = ${membershipId} AND organization_id = ${organizationId}`.execute(trx);
      if (!ok.rows[0]) throw new FinanceError("FINANCE_CAREGIVER_NOT_FOUND", 404);
    }

    const today = await todayPR(trx);
    const from = input.effectiveFrom ?? today;
    const lineVersions = await sql<{ id: string; effective_from: string; effective_to: string | null }>`
      SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to
      FROM finance_rates
      WHERE organization_id = ${organizationId} AND service_id = ${serviceId} AND rate_kind = ${input.rateKind}
        AND scope = ${scope} AND day_type = ${input.dayType}
        AND billing_client_id IS NOT DISTINCT FROM ${clientId}::uuid
        AND organization_worker_membership_id IS NOT DISTINCT FROM ${membershipId}::uuid
        AND cancelled_at IS NULL
      ORDER BY effective_from
    `.execute(trx);
    if (lineVersions.rows.some((v) => v.effective_from === from)) throw new FinanceError("FINANCE_RATE_SAME_START", 409);
    const covering = lineVersions.rows.find((v) => v.effective_from < from && (v.effective_to === null || v.effective_to >= from));
    const next = lineVersions.rows.find((v) => v.effective_from > from);
    // A price already in force is never replaced in the past.
    if (covering && from < today) throw new FinanceError("FINANCE_RATE_PAST_REPLACEMENT", 409);
    // A later version exists: only a past gap may be filled (it ends the day before that version).
    if (next && from >= today) throw new FinanceError("FINANCE_RATE_LATER_VERSION_EXISTS", 409);
    const effectiveTo = next ? addDays(next.effective_from, -1) : null;
    if ((covering || from < today) && !input.reason) throw new FinanceError("FINANCE_RATE_REASON_REQUIRED", 400);

    // The id of the new version is known up front so the version it closes can point to it
    // (F1.1: cancelling a scheduled change reopens exactly that version).
    const newId = (await sql<{ id: string }>`SELECT gen_random_uuid()::text AS id`.execute(trx)).rows[0].id;
    let closed: Record<string, unknown> | null = null;
    if (covering) {
      closed = (await sql<Record<string, unknown>>`
        UPDATE finance_rates SET effective_to = ${addDays(from, -1)}::date, ended_by_user_id = ${userId}, ended_at = now(),
          end_reason = ${input.reason ?? "Nueva tarifa"},
          superseded_by_rate_id = ${newId}::uuid, superseded_previous_to = ${covering.effective_to}::date
        WHERE id = ${covering.id} AND organization_id = ${organizationId}
        RETURNING id, service_id, rate_kind, scope, amount_cents, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                  to_char(effective_to, 'YYYY-MM-DD') AS effective_to
      `.execute(trx)).rows[0];
    }
    const created = (await sql<Record<string, unknown> & { id: string }>`
      INSERT INTO finance_rates (id, organization_id, service_id, rate_kind, scope, billing_client_id, organization_worker_membership_id,
        day_type, amount_cents, effective_from, effective_to, min_minutes, rounding_minutes, half_day_policy, half_day_amount_cents, reason, created_by_user_id)
      VALUES (${newId}::uuid, ${organizationId}, ${serviceId}, ${input.rateKind}, ${scope}, ${clientId}, ${membershipId}, ${input.dayType},
        ${input.amountCents}, ${from}::date, ${effectiveTo}::date, ${input.minMinutes ?? null}, ${input.roundingMinutes ?? null},
        ${input.halfDayPolicy ?? null}, ${input.halfDayAmountCents ?? null}, ${input.reason ?? null}, ${userId})
      RETURNING id, service_id, rate_kind, scope, billing_client_id, organization_worker_membership_id, day_type, amount_cents,
        to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
        min_minutes, rounding_minutes, half_day_policy, half_day_amount_cents, reason
    `.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_RATE_CREATED", entityType: "finance_rate", entityId: created.id, previousValue: closed, newValue: created });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_RATE_CREATED", entityType: "finance_rate", entityId: created.id });
    return { rate: created, closedPrevious: closed };
  }));
}

export async function endRate(userId: string, organizationId: string, rateId: string, input: z.infer<typeof rateEndSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    if (!(await lockServiceOfRate(trx, organizationId, rateId))) throw new FinanceError("FINANCE_RATE_NOT_FOUND", 404);
    const rate = (await sql<{ id: string; service_id: string; effective_from: string; effective_to: string | null; amount_cents: number; cancelled: boolean }>`
      SELECT id, service_id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to, amount_cents,
        cancelled_at IS NOT NULL AS cancelled
      FROM finance_rates WHERE id = ${rateId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
    if (!rate) throw new FinanceError("FINANCE_RATE_NOT_FOUND", 404);
    if (rate.cancelled) throw new FinanceError("FINANCE_RATE_CANCELLED", 409);
    const today = await todayPR(trx);
    // The past is never shortened: the earliest end is yesterday (no rate from today on).
    if (input.effectiveTo < rate.effective_from || input.effectiveTo < addDays(today, -1)) throw new FinanceError("FINANCE_RATE_END_INVALID", 400);
    if (rate.effective_to !== null && input.effectiveTo >= rate.effective_to) throw new FinanceError("FINANCE_RATE_END_ONLY_EARLIER", 409);
    const after = (await sql<Record<string, unknown>>`
      UPDATE finance_rates SET effective_to = ${input.effectiveTo}::date, ended_by_user_id = ${userId}, ended_at = now(), end_reason = ${input.reason}
      WHERE id = ${rateId} AND organization_id = ${organizationId}
      RETURNING id, service_id, amount_cents, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to, end_reason
    `.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_RATE_ENDED", entityType: "finance_rate", entityId: rateId, previousValue: rate, newValue: after });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_RATE_ENDED", entityType: "finance_rate", entityId: rateId });
    return after;
  }));
}

/**
 * F1.1 — cancel a price change that has not taken effect yet (its first day is
 * after today, Puerto Rico). The version is kept, marked cancelled, and stops
 * counting everywhere; the version it had closed is reopened up to where it
 * ended before (never past the cancelled version's own end, so later scheduled
 * versions are untouched). Reason required. The database enforces the same
 * rules (migration 121), also for the table owner.
 */
export async function cancelRate(userId: string, organizationId: string, rateId: string, input: z.infer<typeof rateCancelSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    if (!(await lockServiceOfRate(trx, organizationId, rateId))) throw new FinanceError("FINANCE_RATE_NOT_FOUND", 404);
    const before = (await sql<Record<string, unknown> & { service_id: string; effective_from: string; effective_to: string | null; cancelled_at: string | null }>`
      SELECT id, service_id, rate_kind, scope, billing_client_id, organization_worker_membership_id, day_type, amount_cents,
        to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to, cancelled_at
      FROM finance_rates WHERE id = ${rateId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
    if (!before) throw new FinanceError("FINANCE_RATE_NOT_FOUND", 404);
    if (before.cancelled_at) throw new FinanceError("FINANCE_RATE_CANCELLED", 409);
    const today = await todayPR(trx);
    if (before.effective_from <= today) throw new FinanceError("FINANCE_RATE_ALREADY_IN_FORCE", 409);

    const cancelled = (await sql<Record<string, unknown>>`
      UPDATE finance_rates SET cancelled_at = now(), cancelled_by_user_id = ${userId}, cancel_reason = ${input.reason}
      WHERE id = ${rateId} AND organization_id = ${organizationId}
      RETURNING id, service_id, rate_kind, scope, billing_client_id, organization_worker_membership_id, day_type, amount_cents,
        to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
        cancelled_at, cancel_reason`.execute(trx)).rows[0];

    const previous = (await sql<Record<string, unknown> & { id: string; effective_to: string | null; superseded_previous_to: string | null }>`
      SELECT id, service_id, amount_cents, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
        to_char(effective_to, 'YYYY-MM-DD') AS effective_to, to_char(superseded_previous_to, 'YYYY-MM-DD') AS superseded_previous_to
      FROM finance_rates WHERE superseded_by_rate_id = ${rateId} AND organization_id = ${organizationId} AND cancelled_at IS NULL
      FOR UPDATE`.execute(trx)).rows[0] ?? null;
    let reopened: Record<string, unknown> | null = null;
    if (previous) {
      const a = previous.superseded_previous_to;
      const b = before.effective_to;
      const restoreTo = a === null ? b : b === null ? a : (a < b ? a : b);
      const note = `Restablecida al cancelar el cambio programado: ${input.reason}`.slice(0, 300);
      reopened = (await sql<Record<string, unknown>>`
        UPDATE finance_rates SET effective_to = ${restoreTo}::date,
          superseded_by_rate_id = NULL, superseded_previous_to = NULL,
          ended_at = CASE WHEN ${restoreTo}::date IS NULL THEN NULL ELSE now() END,
          ended_by_user_id = CASE WHEN ${restoreTo}::date IS NULL THEN NULL ELSE ${userId}::uuid END,
          end_reason = CASE WHEN ${restoreTo}::date IS NULL THEN NULL ELSE ${note} END
        WHERE id = ${previous.id} AND organization_id = ${organizationId}
        RETURNING id, service_id, amount_cents, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
          to_char(effective_to, 'YYYY-MM-DD') AS effective_to`.execute(trx)).rows[0];
      await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_RATE_REOPENED", entityType: "finance_rate", entityId: previous.id, previousValue: previous, newValue: reopened });
      await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_RATE_REOPENED", entityType: "finance_rate", entityId: previous.id });
    }
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_RATE_CANCELLED", entityType: "finance_rate", entityId: rateId, previousValue: before, newValue: cancelled });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_RATE_CANCELLED", entityType: "finance_rate", entityId: rateId });
    return { rate: cancelled, reopened };
  }));
}

// ---------------------------------------------------------------------------
// Resolution

interface RateRow {
  id: string; amount_cents: number; scope: string; day_type: string; min_minutes: number | null; rounding_minutes: number | null;
  half_day_policy: HalfDayPolicy | null; half_day_amount_cents: number | null; effective_from: string;
}
export interface ResolvedRate { rateId: string; amountCents: number; source: "client" | "caregiver" | "general"; dayType: "standard" | "holiday"; effectiveFrom: string; rules: Omit<RateRow, "id" | "amount_cents" | "scope" | "day_type" | "effective_from"> }

/**
 * Billing: client's rate for the service → general billing rate.
 * Pay: caregiver's exception for the service → general pay rate.
 * On an agency holiday (Rafa, 24-oct): what was agreed with that client (or
 * that caregiver) prevails over the general holiday rate. Order:
 *   1. holiday rate of that client / caregiver
 *   2. normal rate of that client / caregiver
 *   3. general holiday rate
 *   4. general normal rate
 * On other days holiday versions are ignored. Billing never reads pay rates
 * and vice versa.
 */
async function resolveLine(trx: Trx, organizationId: string, serviceId: string, kind: "client" | "caregiver", targetId: string | null, date: string, holiday: boolean): Promise<ResolvedRate | null> {
  const rows = await sql<RateRow>`
    SELECT id, amount_cents, scope, day_type, min_minutes, rounding_minutes, half_day_policy, half_day_amount_cents,
      to_char(effective_from, 'YYYY-MM-DD') AS effective_from
    FROM finance_rates
    WHERE organization_id = ${organizationId} AND service_id = ${serviceId} AND rate_kind = ${kind}
      AND cancelled_at IS NULL
      AND effective_from <= ${date}::date AND (effective_to IS NULL OR effective_to >= ${date}::date)
      AND (scope = 'general'
           OR (${kind} = 'client' AND scope = 'client' AND billing_client_id = ${targetId}::uuid)
           OR (${kind} = 'caregiver' AND scope = 'caregiver' AND organization_worker_membership_id = ${targetId}::uuid))
  `.execute(trx);
  const rank = (r: RateRow) => (r.day_type === "holiday" && !holiday ? 99 : 0)
    + (r.scope === "general" ? 2 : 0) + (r.day_type === "holiday" ? 0 : 1);
  const best = rows.rows.filter((r) => rank(r) < 99).sort((a, b) => rank(a) - rank(b))[0];
  if (!best) return null;
  return {
    rateId: best.id,
    amountCents: best.amount_cents,
    source: best.scope === "general" ? "general" : (best.scope as "client" | "caregiver"),
    dayType: best.day_type as "standard" | "holiday",
    effectiveFrom: best.effective_from,
    rules: { min_minutes: best.min_minutes, rounding_minutes: best.rounding_minutes, half_day_policy: best.half_day_policy, half_day_amount_cents: best.half_day_amount_cents },
  };
}

async function resolveInTrx(trx: Trx, organizationId: string, params: { serviceId: string; date: string; billingClientId?: string | null; membershipId?: string | null; minutes?: number | null }) {
  const service = (await sql<{ id: string; name: string; unit: FinanceUnit; active: boolean }>`
    SELECT id, name, unit, active FROM finance_services WHERE id = ${params.serviceId} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
  if (!service) throw new FinanceError("FINANCE_SERVICE_NOT_FOUND", 404);
  const holidayRow = (await sql<{ name: string }>`SELECT name FROM finance_holidays WHERE organization_id = ${organizationId} AND holiday_date = ${params.date}::date AND active`.execute(trx)).rows[0];
  const billing = await resolveLine(trx, organizationId, service.id, "client", params.billingClientId ?? null, params.date, Boolean(holidayRow));
  const pay = await resolveLine(trx, organizationId, service.id, "caregiver", params.membershipId ?? null, params.date, Boolean(holidayRow));
  const toRules = (r: ResolvedRate) => ({
    amountCents: r.amountCents, minMinutes: r.rules.min_minutes, roundingMinutes: r.rules.rounding_minutes,
    halfDayPolicy: r.rules.half_day_policy, halfDayAmountCents: r.rules.half_day_amount_cents,
  });
  const minutes = params.minutes ?? null;
  const billingCharge = billing && minutes !== null ? computeCharge(service.unit, minutes, toRules(billing)) : null;
  const payCharge = pay && minutes !== null ? computeCharge(service.unit, minutes, toRules(pay)) : null;
  return {
    service,
    date: params.date,
    holiday: holidayRow ? holidayRow.name : null,
    billing,
    pay,
    unitMargin: billing && pay ? grossMargin(billing.amountCents, pay.amountCents) : null,
    estimate: minutes === null ? null : {
      minutes,
      billing: billingCharge,
      pay: payCharge,
      margin: billingCharge && payCharge ? grossMargin(billingCharge.amountCents, payCharge.amountCents) : null,
    },
    exceptions: [
      ...(billing ? [] : ["NO_BILLING_RATE"]),
      ...(pay ? [] : ["NO_PAY_RATE"]),
      ...(billingCharge?.needsReview || payCharge?.needsReview ? ["PARTIAL_DAY"] : []),
    ],
  };
}

export async function resolveRates(userId: string, organizationId: string, input: z.infer<typeof resolveSchema>) {
  return inFinance(userId, organizationId, async (trx) => resolveInTrx(trx, organizationId, {
    serviceId: input.serviceId, date: input.date ?? (await todayPR(trx)),
    billingClientId: input.billingClientId, membershipId: input.membershipId, minutes: input.minutes ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Clients, holidays, defaults

export async function listClients(userId: string, organizationId: string) {
  return inFinance(userId, organizationId, async (trx) => {
    const clients = await sql`
      SELECT c.id, c.full_name, c.email, c.phone, c.address, c.notes, c.active, c.updated_at,
        COALESCE(json_agg(json_build_object('careRecipientId', cr.id,
          'name', trim(concat_ws(' ', cr.first_name, cr.last_name)), 'isPrimary', l.is_primary)
          ORDER BY cr.last_name) FILTER (WHERE cr.id IS NOT NULL), '[]') AS recipients
      FROM billing_clients c
      LEFT JOIN billing_client_recipients l ON l.billing_client_id = c.id
      LEFT JOIN care_recipients cr ON cr.id = l.care_recipient_id
      WHERE c.organization_id = ${organizationId}
      GROUP BY c.id
      ORDER BY c.active DESC, lower(c.full_name)
    `.execute(trx);
    return { clients: clients.rows };
  });
}

export async function createClient(userId: string, organizationId: string, input: z.infer<typeof clientSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    const c = (await sql<{ id: string }>`
      INSERT INTO billing_clients (organization_id, full_name, email, phone, address, notes, created_by_user_id, updated_by_user_id)
      VALUES (${organizationId}, ${input.fullName}, ${input.email}, ${input.phone}, ${input.address}, ${input.notes}, ${userId}, ${userId})
      RETURNING *`.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_CLIENT_CREATED", entityType: "billing_client", entityId: c.id, newValue: c });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_CLIENT_CREATED", entityType: "billing_client", entityId: c.id });
    return c;
  }));
}

export async function updateClient(userId: string, organizationId: string, clientId: string, input: z.infer<typeof clientUpdateSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    const before = (await sql<Record<string, unknown>>`SELECT * FROM billing_clients WHERE id = ${clientId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
    if (!before) throw new FinanceError("FINANCE_CLIENT_NOT_FOUND", 404);
    const pick = <K extends keyof typeof input>(k: K, col: string) => (input[k] === undefined ? before[col] : input[k]);
    const after = (await sql<Record<string, unknown>>`
      UPDATE billing_clients SET full_name = ${pick("fullName", "full_name") as string}, email = ${pick("email", "email") as string | null},
        phone = ${pick("phone", "phone") as string | null}, address = ${pick("address", "address") as string | null},
        notes = ${pick("notes", "notes") as string | null}, active = ${pick("active", "active") as boolean},
        updated_by_user_id = ${userId}, updated_at = now()
      WHERE id = ${clientId} AND organization_id = ${organizationId} RETURNING *`.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_CLIENT_UPDATED", entityType: "billing_client", entityId: clientId, previousValue: before, newValue: after });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_CLIENT_UPDATED", entityType: "billing_client", entityId: clientId });
    return after;
  }));
}

export async function linkClientRecipient(userId: string, organizationId: string, clientId: string, input: z.infer<typeof clientRecipientSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    const client = await sql`SELECT 1 FROM billing_clients WHERE id = ${clientId} AND organization_id = ${organizationId}`.execute(trx);
    if (!client.rows[0]) throw new FinanceError("FINANCE_CLIENT_NOT_FOUND", 404);
    const recipient = await sql`SELECT 1 FROM care_recipients WHERE id = ${input.careRecipientId} AND organization_id = ${organizationId}`.execute(trx);
    if (!recipient.rows[0]) throw new FinanceError("FINANCE_RECIPIENT_NOT_FOUND", 404);
    if (input.isPrimary) {
      // The previous primary payer of this resident stays linked as secondary.
      await sql`UPDATE billing_client_recipients SET is_primary = false
        WHERE care_recipient_id = ${input.careRecipientId} AND organization_id = ${organizationId} AND is_primary AND billing_client_id <> ${clientId}`.execute(trx);
    }
    const link = (await sql<Record<string, unknown>>`
      INSERT INTO billing_client_recipients (billing_client_id, care_recipient_id, organization_id, is_primary, created_by_user_id)
      VALUES (${clientId}, ${input.careRecipientId}, ${organizationId}, ${input.isPrimary}, ${userId})
      ON CONFLICT (billing_client_id, care_recipient_id) DO UPDATE SET is_primary = EXCLUDED.is_primary
      RETURNING billing_client_id, care_recipient_id, is_primary`.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_CLIENT_RECIPIENT_LINKED", entityType: "billing_client", entityId: clientId, newValue: link });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_CLIENT_RECIPIENT_LINKED", entityType: "billing_client", entityId: clientId });
    return link;
  }));
}

export async function listHolidays(userId: string, organizationId: string) {
  return inFinance(userId, organizationId, async (trx) => ({
    holidays: (await sql`SELECT to_char(h.holiday_date, 'YYYY-MM-DD') AS date, h.name, h.active,
        h.deactivated_at, h.deactivation_reason, u.email AS deactivated_by_email
      FROM finance_holidays h LEFT JOIN users u ON u.id = h.deactivated_by_user_id
      WHERE h.organization_id = ${organizationId} ORDER BY h.active DESC, h.holiday_date`.execute(trx)).rows,
  }));
}

/** Adds a holiday; a date that was deactivated before is reactivated (with the new name). */
export async function addHoliday(userId: string, organizationId: string, input: z.infer<typeof holidaySchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    const existing = (await sql<{ name: string; active: boolean; deactivation_reason: string | null }>`
      SELECT name, active, deactivation_reason FROM finance_holidays
      WHERE organization_id = ${organizationId} AND holiday_date = ${input.date}::date FOR UPDATE`.execute(trx)).rows[0];
    if (existing?.active) throw new FinanceError("FINANCE_DUPLICATE", 409);
    if (existing) {
      const h = (await sql<Record<string, unknown>>`
        UPDATE finance_holidays SET active = true, name = ${input.name}, deactivated_at = NULL, deactivated_by_user_id = NULL,
          deactivation_reason = NULL, updated_by_user_id = ${userId}
        WHERE organization_id = ${organizationId} AND holiday_date = ${input.date}::date
        RETURNING to_char(holiday_date, 'YYYY-MM-DD') AS date, name, active`.execute(trx)).rows[0];
      await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_HOLIDAY_REACTIVATED", entityType: "organization", entityId: organizationId, previousValue: { date: input.date, ...existing }, newValue: h });
      await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_HOLIDAY_REACTIVATED", entityType: "organization", entityId: organizationId });
      return h;
    }
    const h = (await sql<Record<string, unknown>>`INSERT INTO finance_holidays (organization_id, holiday_date, name, created_by_user_id)
      VALUES (${organizationId}, ${input.date}::date, ${input.name}, ${userId})
      RETURNING to_char(holiday_date, 'YYYY-MM-DD') AS date, name, active`.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_HOLIDAY_ADDED", entityType: "organization", entityId: organizationId, newValue: h });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_HOLIDAY_ADDED", entityType: "organization", entityId: organizationId });
    return h;
  }));
}

/**
 * F1.1 — a holiday added by mistake is deactivated (reason required), never
 * deleted: from then on that day uses the normal rates. It can be reactivated
 * by adding the date again.
 */
export async function deactivateHoliday(userId: string, organizationId: string, date: string, input: z.infer<typeof holidayDeactivateSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    const before = (await sql<{ date: string; name: string; active: boolean }>`
      SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, name, active FROM finance_holidays
      WHERE organization_id = ${organizationId} AND holiday_date = ${date}::date FOR UPDATE`.execute(trx)).rows[0];
    if (!before) throw new FinanceError("FINANCE_HOLIDAY_NOT_FOUND", 404);
    if (!before.active) throw new FinanceError("FINANCE_HOLIDAY_ALREADY_INACTIVE", 409);
    const after = (await sql<Record<string, unknown>>`
      UPDATE finance_holidays SET active = false, deactivated_at = now(), deactivated_by_user_id = ${userId},
        deactivation_reason = ${input.reason}, updated_by_user_id = ${userId}
      WHERE organization_id = ${organizationId} AND holiday_date = ${date}::date
      RETURNING to_char(holiday_date, 'YYYY-MM-DD') AS date, name, active, deactivation_reason`.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_HOLIDAY_DEACTIVATED", entityType: "organization", entityId: organizationId, previousValue: before, newValue: after });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_HOLIDAY_DEACTIVATED", entityType: "organization", entityId: organizationId });
    return after;
  }));
}

export async function setRecipientDefaults(userId: string, organizationId: string, recipientId: string, input: z.infer<typeof recipientDefaultsSchema>) {
  return inFinance(userId, organizationId, (trx) => guarded(async () => {
    const recipient = await sql`SELECT 1 FROM care_recipients WHERE id = ${recipientId} AND organization_id = ${organizationId}`.execute(trx);
    if (!recipient.rows[0]) throw new FinanceError("FINANCE_RECIPIENT_NOT_FOUND", 404);
    const row = (await sql<Record<string, unknown>>`
      INSERT INTO recipient_finance_defaults (care_recipient_id, organization_id, service_id, updated_by_user_id)
      VALUES (${recipientId}, ${organizationId}, ${input.serviceId}, ${userId})
      ON CONFLICT (care_recipient_id) DO UPDATE SET service_id = EXCLUDED.service_id, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      RETURNING care_recipient_id, service_id`.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_RECIPIENT_DEFAULTS_SET", entityType: "care_recipient", entityId: recipientId, newValue: row });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_RECIPIENT_DEFAULTS_SET", entityType: "care_recipient", entityId: recipientId });
    return row;
  }));
}

// ---------------------------------------------------------------------------
// Caregivers: legacy hourly rates (058, «Tarifas del equipo») next to the new per-service exceptions

export async function listCaregiverRates(userId: string, organizationId: string) {
  return inFinance(userId, organizationId, async (trx) => {
    const today = await todayPR(trx);
    const rows = await sql`
      SELECT m.id AS membership_id, w.display_name, m.internal_role, m.status AS membership_status,
        legacy.pay_rate_cents AS legacy_pay_rate_cents, legacy.bill_rate_cents AS legacy_bill_rate_cents,
        COALESCE((SELECT json_agg(json_build_object('rateId', r.id, 'serviceId', s.id, 'serviceName', s.name, 'unit', s.unit,
            'amountCents', r.amount_cents, 'dayType', r.day_type, 'effectiveFrom', to_char(r.effective_from, 'YYYY-MM-DD'),
            'effectiveTo', to_char(r.effective_to, 'YYYY-MM-DD')) ORDER BY s.name, r.effective_from)
          FROM finance_rates r JOIN finance_services s ON s.id = r.service_id
          WHERE r.organization_worker_membership_id = m.id AND r.scope = 'caregiver' AND r.cancelled_at IS NULL
            AND (r.effective_to IS NULL OR r.effective_to >= ${today}::date)), '[]') AS exceptions
      FROM organization_worker_memberships m
      JOIN workers w ON w.id = m.worker_id
      LEFT JOIN worker_financial_rates legacy ON legacy.organization_worker_membership_id = m.id
      WHERE m.organization_id = ${organizationId}
      ORDER BY (m.status = 'active') DESC, w.display_name
    `.execute(trx);
    return { today, caregivers: rows.rows };
  });
}

// ---------------------------------------------------------------------------
// Shift finance terms

async function shiftContext(trx: Trx, organizationId: string, shiftId: string) {
  return (await sql<{
    id: string; care_recipient_id: string | null; scheduled_minutes: number; service_date: string; status: string;
    membership_id: string | null; caregiver_name: string | null; approved_minutes: number | null; timesheet_status: string | null;
    terms_service_id: string | null; terms_client_id: string | null; authorized_units_hundredths: number | null; note: string | null;
    default_service_id: string | null; primary_client_id: string | null; terms_updated_at: string | null;
  }>`
    SELECT s.id, s.care_recipient_id, s.status,
      GREATEST(0, round(extract(epoch FROM (s.scheduled_end - s.scheduled_start)) / 60))::int AS scheduled_minutes,
      to_char((s.scheduled_start AT TIME ZONE ${AGENCY_TIME_ZONE})::date, 'YYYY-MM-DD') AS service_date,
      a.organization_worker_membership_id AS membership_id, w.display_name AS caregiver_name,
      t.approved_minutes, t.status AS timesheet_status,
      ft.service_id AS terms_service_id, ft.billing_client_id AS terms_client_id, ft.authorized_units_hundredths, ft.note, ft.updated_at AS terms_updated_at,
      d.service_id AS default_service_id,
      (SELECT l.billing_client_id FROM billing_client_recipients l WHERE l.care_recipient_id = s.care_recipient_id AND l.is_primary) AS primary_client_id
    FROM shifts s
    LEFT JOIN LATERAL (
      SELECT organization_worker_membership_id FROM assignments
      WHERE shift_id = s.id AND organization_id = s.organization_id AND response_status = 'accepted'
      ORDER BY responded_at DESC NULLS LAST, created_at DESC LIMIT 1) a ON true
    LEFT JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id
    LEFT JOIN workers w ON w.id = m.worker_id
    LEFT JOIN timesheets t ON t.shift_id = s.id AND t.organization_worker_membership_id = a.organization_worker_membership_id
    LEFT JOIN shift_finance_terms ft ON ft.shift_id = s.id
    LEFT JOIN recipient_finance_defaults d ON d.care_recipient_id = s.care_recipient_id
    WHERE s.id = ${shiftId} AND s.organization_id = ${organizationId}
  `.execute(trx)).rows[0];
}

export async function getShiftFinance(userId: string, organizationId: string, shiftId: string) {
  return inFinance(userId, organizationId, async (trx) => {
    const ctx = await shiftContext(trx, organizationId, shiftId);
    if (!ctx) throw new FinanceError("SHIFT_NOT_FOUND", 404);
    const serviceId = ctx.terms_service_id ?? ctx.default_service_id;
    const clientId = ctx.terms_client_id ?? ctx.primary_client_id;
    const minutes = ctx.timesheet_status === "approved" && ctx.approved_minutes != null ? ctx.approved_minutes : ctx.scheduled_minutes;
    const resolution = serviceId
      ? await resolveInTrx(trx, organizationId, { serviceId, date: ctx.service_date, billingClientId: clientId, membershipId: ctx.membership_id, minutes })
      : null;
    return {
      shiftId,
      serviceDate: ctx.service_date,
      terms: {
        serviceId: ctx.terms_service_id, billingClientId: ctx.terms_client_id,
        authorizedUnitsHundredths: ctx.authorized_units_hundredths, note: ctx.note, updatedAt: ctx.terms_updated_at,
      },
      effective: {
        serviceId, serviceSource: ctx.terms_service_id ? "shift" : ctx.default_service_id ? "recipient_default" : null,
        billingClientId: clientId, clientSource: ctx.terms_client_id ? "shift" : ctx.primary_client_id ? "recipient_primary" : null,
        membershipId: ctx.membership_id, caregiverName: ctx.caregiver_name,
        minutes, minutesSource: ctx.timesheet_status === "approved" ? "approved_timesheet" : "schedule",
      },
      locked: ctx.timesheet_status === "approved",
      resolution,
      exceptions: [
        ...(serviceId ? [] : ["NO_SERVICE"]),
        ...(clientId ? [] : ["NO_CLIENT"]),
        ...(resolution?.exceptions ?? []),
      ],
    };
  });
}

export async function setShiftFinance(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof shiftTermsSchema>) {
  await inFinance(userId, organizationId, (trx) => guarded(async () => {
    const shift = await sql`SELECT 1 FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx);
    if (!shift.rows[0]) throw new FinanceError("SHIFT_NOT_FOUND", 404);
    if (input.serviceId) {
      const s = (await sql<{ active: boolean }>`SELECT active FROM finance_services WHERE id = ${input.serviceId} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
      if (!s) throw new FinanceError("FINANCE_SERVICE_NOT_FOUND", 404);
      if (!s.active) throw new FinanceError("FINANCE_SERVICE_INACTIVE", 409);
    }
    if (input.billingClientId) {
      const c = await sql`SELECT 1 FROM billing_clients WHERE id = ${input.billingClientId} AND organization_id = ${organizationId} AND active`.execute(trx);
      if (!c.rows[0]) throw new FinanceError("FINANCE_CLIENT_NOT_FOUND", 404);
    }
    const before = (await sql<Record<string, unknown>>`SELECT service_id, billing_client_id, authorized_units_hundredths, note FROM shift_finance_terms WHERE shift_id = ${shiftId}`.execute(trx)).rows[0] ?? null;
    const after = (await sql<Record<string, unknown>>`
      INSERT INTO shift_finance_terms (shift_id, organization_id, service_id, billing_client_id, authorized_units_hundredths, note, updated_by_user_id)
      VALUES (${shiftId}, ${organizationId}, ${input.serviceId}, ${input.billingClientId ?? null}, ${input.authorizedUnitsHundredths ?? null}, ${input.note}, ${userId})
      ON CONFLICT (shift_id) DO UPDATE SET service_id = EXCLUDED.service_id, billing_client_id = EXCLUDED.billing_client_id,
        authorized_units_hundredths = EXCLUDED.authorized_units_hundredths, note = EXCLUDED.note,
        updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      RETURNING service_id, billing_client_id, authorized_units_hundredths, note`.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_SHIFT_TERMS_SET", entityType: "shift", entityId: shiftId, previousValue: before, newValue: after });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_SHIFT_TERMS_SET", entityType: "shift", entityId: shiftId });
  }));
  return getShiftFinance(userId, organizationId, shiftId);
}
