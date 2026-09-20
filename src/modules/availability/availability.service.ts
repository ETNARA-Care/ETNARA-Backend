import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";

export class AvailabilityWorkerNotLinkedError extends Error {
  constructor() {
    super("AVAILABILITY_WORKER_NOT_LINKED");
    this.name = "AvailabilityWorkerNotLinkedError";
  }
}

const weeklyWindowSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
}).refine((window) => window.startTime < window.endTime, { message: "startTime must precede endTime" });

const unavailablePeriodSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().trim().max(120).optional(),
}).refine((period) => new Date(period.startsAt).getTime() < new Date(period.endsAt).getTime(), {
  message: "startsAt must precede endsAt",
});

export const replaceMyAvailabilitySchema = z.object({
  timezone: z.literal("America/Puerto_Rico"),
  weeklyWindows: z.array(weeklyWindowSchema).max(7),
  unavailablePeriods: z.array(unavailablePeriodSchema).max(50),
}).superRefine((input, context) => {
  const weekdays = new Set<number>();
  input.weeklyWindows.forEach((window, index) => {
    if (weekdays.has(window.weekday)) {
      context.addIssue({ code: "custom", message: "Only one weekly window is allowed per weekday", path: ["weeklyWindows", index] });
    }
    weekdays.add(window.weekday);
  });
});
export type ReplaceMyAvailabilityInput = z.infer<typeof replaceMyAvailabilitySchema>;

async function resolveMyMembership(trx: unknown, userId: string, organizationId: string): Promise<string> {
  const result = await sql<{ id: string }>`
    SELECT owm.id
    FROM organization_worker_memberships owm
    JOIN workers w ON w.id = owm.worker_id
    WHERE w.user_id = ${userId}
      AND owm.organization_id = ${organizationId}
      AND owm.status = 'active'
    LIMIT 1
  `.execute(trx as never);
  if (!result.rows[0]) throw new AvailabilityWorkerNotLinkedError();
  return result.rows[0].id;
}

export async function getMyAvailability(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const membershipId = await resolveMyMembership(trx, userId, organizationId);
    const [settings, weekly, unavailable] = await Promise.all([
      sql<{ timezone: string }>`
        SELECT timezone FROM worker_availability_settings
        WHERE organization_worker_membership_id = ${membershipId}
        LIMIT 1
      `.execute(trx),
      sql<{ id: string; weekday: number; start_time: string; end_time: string }>`
        SELECT id, weekday, start_time::text, end_time::text
        FROM worker_weekly_availability
        WHERE organization_worker_membership_id = ${membershipId}
        ORDER BY weekday, start_time
      `.execute(trx),
      sql<{ id: string; starts_at: string; ends_at: string; reason: string | null }>`
        SELECT id, starts_at, ends_at, reason
        FROM worker_unavailability_periods
        WHERE organization_worker_membership_id = ${membershipId} AND ends_at >= now()
        ORDER BY starts_at
      `.execute(trx),
    ]);
    return {
      configured: Boolean(settings.rows[0]),
      timezone: settings.rows[0]?.timezone ?? "America/Puerto_Rico",
      weeklyWindows: weekly.rows.map((window) => ({
        id: window.id,
        weekday: window.weekday,
        startTime: window.start_time.slice(0, 5),
        endTime: window.end_time.slice(0, 5),
      })),
      unavailablePeriods: unavailable.rows.map((period) => ({
        id: period.id,
        startsAt: period.starts_at,
        endsAt: period.ends_at,
        reason: period.reason,
      })),
    };
  });
}

export async function replaceMyAvailability(
  userId: string,
  organizationId: string,
  input: ReplaceMyAvailabilityInput
) {
  await withTenantContext({ userId, organizationId }, async (trx) => {
    const membershipId = await resolveMyMembership(trx, userId, organizationId);
    await sql`DELETE FROM worker_weekly_availability WHERE organization_worker_membership_id = ${membershipId}`.execute(trx);
    await sql`DELETE FROM worker_unavailability_periods WHERE organization_worker_membership_id = ${membershipId}`.execute(trx);
    await sql`
      INSERT INTO worker_availability_settings (
        organization_worker_membership_id, organization_id, timezone
      ) VALUES (${membershipId}, ${organizationId}, ${input.timezone})
      ON CONFLICT (organization_worker_membership_id)
      DO UPDATE SET timezone = EXCLUDED.timezone, updated_at = now()
    `.execute(trx);

    for (const window of input.weeklyWindows) {
      await sql`
        INSERT INTO worker_weekly_availability (
          organization_worker_membership_id, organization_id, weekday, start_time, end_time
        ) VALUES (${membershipId}, ${organizationId}, ${window.weekday}, ${window.startTime}, ${window.endTime})
      `.execute(trx);
    }
    for (const period of input.unavailablePeriods) {
      await sql`
        INSERT INTO worker_unavailability_periods (
          organization_worker_membership_id, organization_id, starts_at, ends_at, reason
        ) VALUES (
          ${membershipId}, ${organizationId}, ${period.startsAt}, ${period.endsAt}, ${period.reason ?? null}
        )
      `.execute(trx);
    }
  });
  return getMyAvailability(userId, organizationId);
}
