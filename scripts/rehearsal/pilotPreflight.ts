/**
 * Pilot preflight for ONE organization in production. STRICTLY READ-ONLY:
 * the session is read-only (default_transaction_read_only) and every query runs
 * inside BEGIN READ ONLY ... ROLLBACK. Prints counts, flags and masked e-mails
 * only — never names, birth dates, addresses or any clinical field of people
 * receiving care.
 *   PILOT_ORG_ID  full uuid of the organization to inspect (required)
 *   PREFLIGHT_URL connection string (Railway variable; never logged)
 */
import { Client } from "pg";

const mask = (e: string | null) => {
  if (!e) return "(sin correo)";
  const [u, d] = e.split("@");
  return `${u.slice(0, 2)}***@${d ?? "?"}`;
};

const c = new Client({ connectionString: process.env.PREFLIGHT_URL, options: "-c default_transaction_read_only=on", connectionTimeoutMillis: 15000, statement_timeout: 20000 });

(async () => {
  const org = process.env.PILOT_ORG_ID ?? "";
  if (!/^[0-9a-f-]{36}$/.test(org)) throw new Error("PILOT_ORG_ID must be a full uuid");
  await c.connect();
  await c.query("BEGIN READ ONLY");
  const q = async <T extends Record<string, unknown>>(s: string, p: unknown[] = []) => (await c.query<T>(s, p)).rows;
  const out: Record<string, unknown> = {};

  out.organization = (await q(`SELECT id, name, organization_type, status, created_at, archived_at FROM organizations WHERE id=$1`, [org]))[0] ?? null;
  out.features = await q(`SELECT feature_code, enabled, updated_at FROM organization_features WHERE organization_id=$1 ORDER BY feature_code`, [org]);
  out.featureHistory = (await q<{ feature_code: string; enabled: boolean; reason: string; occurred_at: string; email: string | null }>(
    `SELECT e.feature_code, e.enabled, e.reason, e.occurred_at, u.email FROM organization_feature_events e JOIN users u ON u.id=e.actor_user_id WHERE e.organization_id=$1 ORDER BY e.occurred_at`, [org]))
    .map((h) => ({ ...h, email: mask(h.email) }));

  out.members = (await q<{ email: string | null; phone: boolean; status: string; user_status: string; roles: string[] }>(
    `SELECT u.email, (u.phone IS NOT NULL) phone, m.status, u.status user_status,
            coalesce(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}') roles
       FROM organization_memberships m JOIN users u ON u.id=m.user_id
       LEFT JOIN user_roles ur ON ur.organization_membership_id=m.id LEFT JOIN roles r ON r.id=ur.role_id
      WHERE m.organization_id=$1 GROUP BY u.email, u.phone, m.status, u.status ORDER BY 5, 1`, [org]))
    .map((m) => ({ ...m, email: mask(m.email) }));

  out.workers = (await q(
    `SELECT owm.status, owm.internal_role,
            EXISTS (SELECT 1 FROM credentials cr JOIN organization_credential_reviews rv ON rv.credential_id=cr.id
                     WHERE cr.worker_id=owm.worker_id AND rv.organization_id=owm.organization_id AND rv.review_status='approved') credential_approved,
            EXISTS (SELECT 1 FROM worker_weekly_availability a WHERE a.organization_worker_membership_id=owm.id) availability_set,
            (w.user_id IS NOT NULL) has_login
       FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id
      WHERE owm.organization_id=$1 ORDER BY 1, 2`, [org]));

  out.careRecipients = (await q(
    `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int active, count(*)::int total,
            min(created_at) first_created, max(created_at) last_created,
            (SELECT count(*)::int FROM care_recipient_locations l WHERE l.organization_id=$1) with_address,
            (SELECT count(*)::int FROM care_recipient_locations l WHERE l.organization_id=$1 AND l.latitude IS NOT NULL) with_map_point
       FROM care_recipients WHERE organization_id=$1`, [org]))[0];

  out.family = (await q<{ email: string | null; status: string; notif: boolean; addr: boolean }>(
    `SELECT u.email, f.status, f.can_receive_notifications notif, f.can_view_service_location addr
       FROM family_relationships f JOIN users u ON u.id=f.user_id WHERE f.organization_id=$1 ORDER BY 1`, [org]))
    .map((f) => ({ ...f, email: mask(f.email) }));

  out.activity = (await q(
    `SELECT (SELECT count(*)::int FROM shifts WHERE organization_id=$1) shifts,
            (SELECT count(*)::int FROM shifts WHERE organization_id=$1 AND scheduled_start > now()) future_shifts,
            (SELECT count(*)::int FROM notifications WHERE organization_id=$1 AND created_at > now() - interval '7 days') notifications_7d,
            (SELECT count(*)::int FROM smartmatch_opportunities WHERE organization_id=$1) opportunities,
            (SELECT count(*)::int FROM shift_journey_events WHERE organization_id=$1) journey_events`, [org]))[0];

  out.otherOrganizations = (await q(
    `SELECT count(*)::int organizations,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM organization_features f WHERE f.organization_id=o.id AND f.enabled))::int with_any_feature_on
       FROM organizations o WHERE o.id <> $1`, [org]))[0];
  out.otherOrganizationsOn = await q(
    `SELECT o.id, o.name, f.feature_code FROM organization_features f JOIN organizations o ON o.id=f.organization_id WHERE f.enabled AND o.id <> $1`, [org]);

  await c.query("ROLLBACK");
  console.log("PILOT_PREFLIGHT " + JSON.stringify(out));
})().catch((e) => { console.error("PILOT_PREFLIGHT_ERROR", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => c.end().catch(() => undefined));
