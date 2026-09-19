import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { InvalidTenantContextError } from "../../context/errors.js";
import { withTenantContext } from "../../context/tenantContext.js";

const uuidSchema = z.string().uuid();

export class CarePlanAccessDeniedError extends Error {
  constructor() {
    super("CARE_PLAN_ACCESS_DENIED");
    this.name = "CarePlanAccessDeniedError";
  }
}

export class CarePlanManagementForbiddenError extends Error {
  constructor() {
    super("CARE_PLAN_MANAGEMENT_FORBIDDEN");
    this.name = "CarePlanManagementForbiddenError";
  }
}

export class CarePlanRecipientNotFoundError extends Error {
  constructor() {
    super("CARE_PLAN_RECIPIENT_NOT_FOUND");
    this.name = "CarePlanRecipientNotFoundError";
  }
}

const taskSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(120),
  details: z.string().trim().max(500).optional(),
  category: z.enum([
    "MEAL",
    "HYDRATION",
    "HYGIENE",
    "MOBILITY",
    "MEDICATION_REMINDER",
    "COMPANIONSHIP",
    "SAFETY",
    "OTHER",
  ]),
  frequency: z.enum(["EVERY_SHIFT", "DAILY", "SPECIFIC_DAYS", "AS_NEEDED"]),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  priority: z.enum(["ROUTINE", "IMPORTANT", "CRITICAL"]),
  requiresConfirmation: z.boolean().default(true),
});

export const carePlanDetailsSchema = z.object({
  supportLevel: z.enum(["LOW", "MODERATE", "HIGH", "COMPLEX"]),
  goals: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  instructions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  precautions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  tasks: z.array(taskSchema).max(40).default([]),
});

export type CarePlanDetailsInput = z.input<typeof carePlanDetailsSchema>;
export type CarePlanDetails = z.output<typeof carePlanDetailsSchema> & {
  tasks: Array<z.output<typeof taskSchema> & { id: string }>;
};

interface CarePlanRow {
  id: string;
  organization_id: string;
  care_recipient_id: string;
  version: number;
  plan_details: CarePlanDetails;
  effective_from: string;
  effective_to: string | null;
  status: "active" | "superseded";
  created_at: string;
  created_by_user_id: string | null;
}

function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID`);
  }
}

async function assertRecipientExists(trx: unknown, organizationId: string, recipientId: string) {
  const result = await sql<{ id: string }>`
    SELECT id
    FROM care_recipients
    WHERE id = ${recipientId} AND organization_id = ${organizationId}
    LIMIT 1
  `.execute(trx as never);
  if (!result.rows[0]) throw new CarePlanRecipientNotFoundError();
}

async function assertPlanReader(trx: unknown, organizationId: string, recipientId: string) {
  const result = await sql<{ allowed: boolean }>`
    SELECT (
      app_is_org_manager()
      OR app_is_superadmin()
      OR EXISTS (
        SELECT 1
        FROM workers w
        JOIN organization_worker_memberships owm
          ON owm.worker_id = w.id
         AND owm.organization_id = ${organizationId}
         AND owm.status = 'active'
        JOIN assignments a
          ON a.organization_worker_membership_id = owm.id
         AND a.organization_id = ${organizationId}
         AND a.response_status IN ('pending', 'accepted')
        JOIN shifts s
          ON s.id = a.shift_id
         AND s.organization_id = ${organizationId}
         AND s.status != 'cancelled'
        WHERE w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND (
            s.care_recipient_id = ${recipientId}
            OR a.care_recipient_id = ${recipientId}
            OR (
              s.room_id IS NOT NULL
              AND s.room_id = (
                SELECT room_id FROM care_recipients
                WHERE id = ${recipientId} AND organization_id = ${organizationId}
              )
            )
          )
      )
    ) AS allowed
  `.execute(trx as never);
  if (!result.rows[0]?.allowed) throw new CarePlanAccessDeniedError();
}

async function assertPlanManager(trx: unknown) {
  const result = await sql<{ allowed: boolean }>`
    SELECT (app_is_org_manager() OR app_is_superadmin()) AS allowed
  `.execute(trx as never);
  if (!result.rows[0]?.allowed) throw new CarePlanManagementForbiddenError();
}

function normalizeDetails(input: CarePlanDetailsInput): CarePlanDetails {
  const parsed = carePlanDetailsSchema.parse(input);
  return {
    ...parsed,
    tasks: parsed.tasks.map((task) => ({ ...task, id: task.id ?? randomUUID() })),
  };
}

export async function getActiveCarePlan(
  userId: string,
  organizationId: string,
  recipientId: string
): Promise<CarePlanRow | null> {
  assertUuid(recipientId, "recipientId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertRecipientExists(trx, organizationId, recipientId);
    await assertPlanReader(trx, organizationId, recipientId);
    const result = await sql<CarePlanRow>`
      SELECT id, organization_id, care_recipient_id, version, plan_details,
             effective_from, effective_to, status, created_at, created_by_user_id
      FROM care_plans
      WHERE organization_id = ${organizationId}
        AND care_recipient_id = ${recipientId}
        AND status = 'active'
      LIMIT 1
    `.execute(trx);
    return result.rows[0] ?? null;
  });
}

export async function createCarePlanVersion(
  userId: string,
  organizationId: string,
  recipientId: string,
  input: CarePlanDetailsInput
): Promise<CarePlanRow> {
  assertUuid(recipientId, "recipientId");
  const details = normalizeDetails(input);
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertPlanManager(trx);

    const recipient = await sql<{ id: string }>`
      SELECT id
      FROM care_recipients
      WHERE id = ${recipientId} AND organization_id = ${organizationId}
      FOR UPDATE
    `.execute(trx);
    if (!recipient.rows[0]) throw new CarePlanRecipientNotFoundError();

    const versionResult = await sql<{ next_version: number }>`
      SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
      FROM care_plans
      WHERE organization_id = ${organizationId} AND care_recipient_id = ${recipientId}
    `.execute(trx);
    const nextVersion = versionResult.rows[0]?.next_version ?? 1;

    await sql`
      UPDATE care_plans
      SET status = 'superseded', effective_to = now()
      WHERE organization_id = ${organizationId}
        AND care_recipient_id = ${recipientId}
        AND status = 'active'
    `.execute(trx);

    const result = await sql<CarePlanRow>`
      INSERT INTO care_plans (
        organization_id, care_recipient_id, version, plan_details, created_by_user_id
      ) VALUES (
        ${organizationId}, ${recipientId}, ${nextVersion}, ${JSON.stringify(details)}::jsonb, ${userId}
      )
      RETURNING id, organization_id, care_recipient_id, version, plan_details,
                effective_from, effective_to, status, created_at, created_by_user_id
    `.execute(trx);
    return result.rows[0];
  });
}
