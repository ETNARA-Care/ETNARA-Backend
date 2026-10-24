/**
 * Pilot preflight for ONE organization in production. STRICTLY READ-ONLY and
 * least-privilege: it must log in as etnara_preflight_ro (ops/rehearsal/
 * preflight-ro-role.create.sql) — NOBYPASSRLS, column-level SELECT only — and
 * refuses any other login. Reads inside BEGIN READ ONLY ... ROLLBACK with the
 * same RLS scope ETNARA Central uses (app.is_superadmin + an active platform
 * admin), so every row-level policy applies. Prints flags, counts and e-mail
 * DOMAINS only: no names, birth dates, addresses or clinical fields.
 *   PILOT_ORG_ID  full uuid of the organization to inspect (required)
 *   PREFLIGHT_URL connection string (Railway variable; never logged)
 */
import { Client } from "pg";

const EXPECTED_ROLE = "etnara_preflight_ro";
const domain = (e: string | null) => (e ? `***@${e.split("@")[1] ?? "?"}` : "(sin correo)");
const c = new Client({ connectionString: process.env.PREFLIGHT_URL, connectionTimeoutMillis: 15000, statement_timeout: 20000 });

(async () => {
  const org = process.env.PILOT_ORG_ID ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(org)) throw new Error("PILOT_ORG_ID must be a full uuid");
  await c.connect();

  // Refuse unless this is the dedicated least-privilege login.
  const who = (await c.query<{ u: string; su: boolean; bypass: boolean; createrole: boolean; ro: string; w: number }>(
    `SELECT current_user u, r.rolsuper su, r.rolbypassrls bypass, r.rolcreaterole createrole,
            current_setting('default_transaction_read_only') ro,
            (SELECT count(*)::int FROM pg_class k JOIN pg_namespace n ON n.oid=k.relnamespace
              WHERE n.nspname='public' AND k.relkind IN ('r','p')
                AND has_table_privilege(current_user, k.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                -- migration 074 grants this one to PUBLIC; RLS + read-only still block writes
                AND k.relname <> 'password_reset_tokens') w
       FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if (who.u !== EXPECTED_ROLE || who.su || who.bypass || who.createrole || who.ro !== "on" || who.w !== 0)
    throw new Error(`refused: role=${who.u} superuser=${who.su} bypassrls=${who.bypass} createrole=${who.createrole} read_only=${who.ro} writable_tables=${who.w}`);
  console.log(`PILOT_PREFLIGHT_ROLE ${who.u} superuser=${who.su} bypassrls=${who.bypass} read_only=${who.ro} writable_tables=${who.w}`);

  await c.query("BEGIN READ ONLY");
  const q = async <T extends Record<string, unknown>>(s: string, p: unknown[] = []) => (await c.query<T>(s, p)).rows;
  if ((await q<{ v: string }>(`SELECT current_setting('transaction_read_only') v`))[0].v !== "on") throw new Error("refused: transaction is not read-only");

  // RLS scope of ETNARA Central (transaction-local settings, gone at ROLLBACK).
  const admin = (await q<{ user_id: string }>(`SELECT user_id FROM platform_admins WHERE revoked_at IS NULL LIMIT 1`))[0];
  if (!admin) throw new Error("no active platform admin to scope RLS");
  await q(`SELECT set_config('app.current_user_id', $1, true), set_config('app.is_superadmin', 'true', true)`, [admin.user_id]);

  const out: Record<string, unknown> = {};
  out.organization = (await q(`SELECT id, name, organization_type, status, created_at, archived_at FROM organizations WHERE id=$1`, [org]))[0] ?? null;
  out.features = await q(`SELECT feature_code, enabled, updated_at FROM organization_features WHERE organization_id=$1 ORDER BY feature_code`, [org]);
  out.featureHistory = await q(`SELECT feature_code, enabled, reason, occurred_at FROM organization_feature_events WHERE organization_id=$1 ORDER BY occurred_at`, [org]);

  out.members = (await q<{ email: string | null; status: string; user_status: string; roles: string[] }>(
    `SELECT u.email, m.status, u.status user_status,
            coalesce(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}') roles
       FROM organization_memberships m JOIN users u ON u.id=m.user_id
       LEFT JOIN user_roles ur ON ur.organization_membership_id=m.id AND ur.organization_id=m.organization_id
       LEFT JOIN roles r ON r.id=ur.role_id
      WHERE m.organization_id=$1 GROUP BY u.id, u.email, m.status, u.status ORDER BY 4, 1`, [org]))
    .map((m) => ({ ...m, email: domain(m.email) }));

  out.workers = await q(
    `SELECT owm.status, owm.internal_role,
            EXISTS (SELECT 1 FROM credentials cr JOIN organization_credential_reviews rv ON rv.credential_id=cr.id
                     WHERE cr.worker_id=owm.worker_id AND rv.organization_id=owm.organization_id AND rv.review_status='approved') credential_approved,
            (w.user_id IS NOT NULL) has_login
       FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id
      WHERE owm.organization_id=$1 ORDER BY 1, 2`, [org]);

  out.careRecipients = (await q(
    `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int active, count(*)::int total FROM care_recipients WHERE organization_id=$1`, [org]))[0];

  out.family = (await q<{ email: string | null; status: string; notif: boolean; addr: boolean }>(
    `SELECT u.email, f.status, f.can_receive_notifications notif, f.can_view_service_location addr
       FROM family_relationships f LEFT JOIN users u ON u.id=f.user_id WHERE f.organization_id=$1 ORDER BY 1`, [org]))
    .map((f) => ({ ...f, email: domain(f.email) }));

  out.activity = (await q(
    `SELECT (SELECT count(*)::int FROM notifications WHERE organization_id=$1 AND created_at > now() - interval '7 days') notifications_7d`, [org]))[0];

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
