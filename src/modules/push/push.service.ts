import { sql } from "kysely";
import { z } from "zod";
import { withUserContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";
import { notificationTargetPath, type PushAudience } from "./pushTarget.js";

/**
 * Web Push (146) — what a signed-in person does with her own phones and preferences.
 * Registration and removal go through SECURITY DEFINER functions that validate the session,
 * the endpoint (known push services only) and the person's access; nothing here can touch
 * another person's subscription.
 */
const base64url = (min: number, max: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}={0,2}$`));

export const registerSubscriptionSchema = z.object({
  endpoint: z.string().url().startsWith("https://").max(1024),
  keys: z.object({ p256dh: base64url(86, 88), auth: base64url(22, 24) }).strict(),
  deviceLabel: z.string().trim().max(60).optional(),
  expirationTime: z.number().nullable().optional(),
}).strict();

export const unregisterSchema = z.object({ endpoint: z.string().url().max(1024) }).strict();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const preferencesSchema = z.object({
  quietEnabled: z.boolean(),
  quietStart: hhmm,
  quietEnd: hhmm,
  agencyAlerts: z.boolean().nullable(),
}).strict().refine((p) => p.quietStart !== p.quietEnd, { message: "QUIET_RANGE_EMPTY" });

export class PushError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); this.name = "PushError"; }
}

const KNOWN: Record<string, number> = {
  PUSH_ENDPOINT_NOT_ALLOWED: 400, PUSH_SESSION_INVALID: 401, PUSH_NO_ACTIVE_ACCESS: 403,
  PUSH_NOT_ALLOWED: 403, PUSH_NO_SUBSCRIPTION: 409, PUSH_TEST_RATE_LIMITED: 429,
};
function mapDbError(error: unknown): never {
  const message = (error as { message?: string })?.message ?? "";
  for (const [code, status] of Object.entries(KNOWN)) if (message.includes(code)) throw new PushError(code, status);
  if ((error as { code?: string })?.code === "23514") throw new PushError("PUSH_SUBSCRIPTION_INVALID", 400);
  throw error;
}

const uuid = z.string().uuid();
function assertUuid(value: string, label: string) {
  if (!uuid.safeParse(value).success) throw new InvalidTenantContextError(`${label} must be a valid UUID`);
}

export async function registerSubscription(userId: string, sessionId: string, input: z.infer<typeof registerSubscriptionSchema>) {
  try {
    return await withUserContext(userId, async (trx) => {
      const r = await sql<{ id: string }>`SELECT app_push_register(${sessionId}::uuid, ${input.endpoint}, ${input.keys.p256dh},
        ${input.keys.auth}, ${input.deviceLabel ?? null}) AS id`.execute(trx);
      return { id: r.rows[0].id };
    });
  } catch (error) { mapDbError(error); }
}

export async function unregisterSubscription(userId: string, endpoint: string): Promise<number> {
  try {
    return await withUserContext(userId, async (trx) =>
      Number((await sql<{ n: number }>`SELECT app_push_unregister(${endpoint}) AS n`.execute(trx)).rows[0]?.n ?? 0));
  } catch (error) { mapDbError(error); }
}

export async function listMySubscriptions(userId: string, sessionId: string) {
  return withUserContext(userId, async (trx) => (await sql<{ id: string; device_label: string | null; created_at: string;
    last_success_at: string | null; this_session: boolean }>`
    SELECT id, device_label, created_at, last_success_at, (session_id = ${sessionId}::uuid) AS this_session
      FROM push_subscriptions WHERE user_id = ${userId} ORDER BY last_seen_at DESC`.execute(trx)).rows.map((r) => ({
    id: r.id, deviceLabel: r.device_label, createdAt: r.created_at, lastSuccessAt: r.last_success_at, thisSession: r.this_session === true,
  })));
}

export async function deleteMySubscription(userId: string, subscriptionId: string): Promise<boolean> {
  assertUuid(subscriptionId, "subscriptionId");
  return withUserContext(userId, async (trx) => {
    // Through app_push_unregister so the removal is audited like any other.
    const r = await sql<{ n: number }>`SELECT app_push_unregister(endpoint) AS n FROM push_subscriptions
      WHERE id = ${subscriptionId} AND user_id = ${userId}`.execute(trx);
    return Number(r.rows[0]?.n ?? 0) > 0;
  });
}

/** Preferences, plus whether this person is agency staff in any active agency (to show the agency switch). */
export async function getPreferences(userId: string) {
  return withUserContext(userId, async (trx) => {
    const p = (await sql<{ quiet_enabled: boolean; quiet_start: string; quiet_end: string; agency_alerts: boolean | null }>`
      SELECT quiet_enabled, to_char(quiet_start, 'HH24:MI') AS quiet_start, to_char(quiet_end, 'HH24:MI') AS quiet_end, agency_alerts
        FROM push_preferences WHERE user_id = ${userId}`.execute(trx)).rows[0];
    const roles = (await sql<{ code: string }>`
      SELECT DISTINCT r.code FROM organization_memberships om
        JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
        JOIN roles r ON r.id = ur.role_id
       WHERE om.user_id = ${userId} AND om.status = 'active'`.execute(trx)).rows.map((r) => r.code);
    const isAdmin = roles.includes("ORGANIZATION_ADMIN");
    const isSupervisor = roles.includes("SUPERVISOR");
    return {
      quietEnabled: p?.quiet_enabled ?? false,
      quietStart: p?.quiet_start ?? "22:00",
      quietEnd: p?.quiet_end ?? "07:00",
      agencyAlerts: p?.agency_alerts ?? null,
      agencyRole: isAdmin ? "admin" : isSupervisor ? "supervisor" : null,
      // What actually happens with agency alerts for this person (null preference = role default).
      agencyAlertsEffective: isAdmin ? p?.agency_alerts !== false : isSupervisor ? p?.agency_alerts === true : false,
    };
  });
}

export async function setPreferences(userId: string, input: z.infer<typeof preferencesSchema>) {
  await withUserContext(userId, async (trx) => {
    await sql`INSERT INTO push_preferences (user_id, quiet_enabled, quiet_start, quiet_end, agency_alerts, updated_at)
      VALUES (${userId}, ${input.quietEnabled}, ${input.quietStart}::time, ${input.quietEnd}::time, ${input.agencyAlerts}, now())
      ON CONFLICT (user_id) DO UPDATE SET quiet_enabled = EXCLUDED.quiet_enabled, quiet_start = EXCLUDED.quiet_start,
        quiet_end = EXCLUDED.quiet_end, agency_alerts = EXCLUDED.agency_alerts, updated_at = now()`.execute(trx);
  });
  return getPreferences(userId);
}

export async function sendTestNotification(userId: string): Promise<{ notificationId: string }> {
  try {
    return await withUserContext(userId, async (trx) => ({
      notificationId: (await sql<{ id: string }>`SELECT app_push_test() AS id`.execute(trx)).rows[0].id,
    }));
  } catch (error) { mapDbError(error); }
}

/**
 * Where a notification opens. The person must own it (RLS) and STILL have the role or
 * relationship it was meant for, in an active agency; otherwise path is null and the portal
 * shows her inbox. Opening never depends on quiet hours or the push switch.
 */
export async function getNotificationTarget(userId: string, notificationId: string) {
  assertUuid(notificationId, "notificationId");
  return withUserContext(userId, async (trx) => {
    const n = (await sql<{ id: string; organization_id: string | null; notification_type: string; related_entity_type: string | null;
      related_entity_id: string | null; shift_id: string | null }>`
      SELECT id, organization_id, notification_type, related_entity_type, related_entity_id,
             CASE WHEN related_entity_type = 'assignment' THEN app_notification_assignment_shift_id(id)
                  WHEN related_entity_type = 'shift' THEN related_entity_id END AS shift_id
        FROM notifications WHERE id = ${notificationId} AND user_id = ${userId}`.execute(trx)).rows[0];
    if (!n) return null;
    const resolved = (await sql<{ reason: string | null; audience: PushAudience | null }>`
      SELECT reason, audience FROM app_push_resolve(${notificationId}::uuid, true)`.execute(trx)).rows[0];
    if (!resolved || resolved.reason || !resolved.audience) return { path: null, organizationId: null, portal: null };
    const path = notificationTargetPath({ type: n.notification_type, audience: resolved.audience,
      relatedEntityType: n.related_entity_type, relatedEntityId: n.related_entity_id, shiftId: n.shift_id });
    // 147: quien se postuló a SmartMatch puede no ser miembro de la agencia que publicó: se queda
    // en su agencia activa (sin cambiar de organización) y abre sus propias solicitudes.
    const portal = resolved.audience === "self" ? null : resolved.audience === "applicant" ? "caregiver" : resolved.audience;
    const organizationId = path && resolved.audience !== "applicant" ? n.organization_id : null;
    return { path, organizationId, portal: path ? portal : null };
  });
}
