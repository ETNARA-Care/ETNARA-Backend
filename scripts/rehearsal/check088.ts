/**
 * Post-migration check of the production security hotfix (088) on a REHEARSAL
 * COPY: catalog (policies, privileges, triggers) + functional probes executed
 * AS app_runtime (SET LOCAL ROLE) with the copy's own users, inside
 * transactions that are ALWAYS rolled back. Output: counts and verdicts only.
 *
 *   CHECK088_URL=postgres://<superuser>@<copy>/<db> npx tsx scripts/rehearsal/check088.ts
 * Refuses to run unless the database carries the rehearsal marker table or
 * CHECK088_ALLOW_UNMARKED_COPY names exactly this host (a PITR copy).
 */
import { Client } from "pg";

type Result = { name: string; pass: boolean; detail: string };

export async function check088(url: string, allowHost?: string): Promise<Result[]> {
  const host = new URL(url).hostname;
  const c = new Client({ connectionString: url });
  await c.connect();
  const results: Result[] = [];
  const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
  const q = async <T extends Record<string, unknown>>(s: string, p: unknown[] = []) => (await c.query<T>(s, p)).rows;
  try {
    const marked = (await q<{ ok: boolean }>(`SELECT to_regclass('public.etnara_rehearsal_marker') IS NOT NULL AS ok`))[0].ok;
    if (!marked && allowHost !== host) throw new Error(`refused: ${host} is not a marked rehearsal copy (set CHECK088_ALLOW_UNMARKED_COPY=${host} only for a PITR copy)`);
    if (["etnara-care-staging-db.railway.internal"].includes(host)) throw new Error("refused: production host");

    // ---------------------------------------------------------- catalog
    const last = (await q<{ f: string }>(`SELECT max(filename) f FROM schema_migrations`))[0].f;
    const expectLast = process.env.CHECK088_EXPECT_LAST ?? "088_production_security_hotfix.sql";
    const has088 = (await q<{ n: number }>(`SELECT count(*)::int n FROM schema_migrations WHERE filename = '088_production_security_hotfix.sql'`))[0].n === 1;
    check(`C1 088 applied; last migration is ${expectLast}`, has088 && last === expectLast, last);
    const pol = new Set((await q<{ p: string }>(`SELECT tablename||'.'||policyname p FROM pg_policies WHERE schemaname='public'`)).map((r) => r.p));
    const want = ["users.users_read_self_or_shared_org", "users.users_update_self", "shifts.shifts_worker_assigned_read", "shifts.shifts_worker_assigned_status",
      "family_relationships.family_relationships_read", "family_relationships.family_relationships_insert", "family_relationships.family_relationships_manager_update",
      "family_relationships.family_relationships_manager_delete", "notifications.platform_phi_deny"];
    const gone = ["users.users_self_or_shared_org", "shifts.shifts_worker_assigned_only", "family_relationships.family_relationships_own_or_staff"];
    check("C2 new policies present, old permissive ones removed", want.every((p) => pol.has(p)) && gone.every((p) => !pol.has(p)),
      `missing=${want.filter((p) => !pol.has(p)).join("|")} stale=${gone.filter((p) => pol.has(p)).join("|")}`);
    const tablePriv = (await q<{ p: string }>(`SELECT privilege_type p FROM information_schema.role_table_grants WHERE grantee='app_runtime' AND table_name='users'`)).map((r) => r.p).sort();
    const colUpd = (await q<{ c: string }>(`SELECT column_name c FROM information_schema.column_privileges WHERE grantee='app_runtime' AND table_name='users' AND privilege_type='UPDATE'`)).map((r) => r.c).sort();
    check("C3 app_runtime on users: SELECT only + UPDATE(password_hash, updated_at)",
      JSON.stringify(tablePriv) === JSON.stringify(["SELECT"]) && JSON.stringify(colUpd) === JSON.stringify(["password_hash", "updated_at"]), `${tablePriv}|${colUpd}`);
    const trg = new Set((await q<{ t: string }>(`SELECT tgname t FROM pg_trigger WHERE NOT tgisinternal`)).map((r) => r.t));
    check("C4 guard triggers present", trg.has("shifts_core_guard") && trg.has("family_relationships_immutable_subject"));

    // ---------------------------------------------------------- functional probes (as app_runtime, rolled back)
    const asRuntime = async <T extends Record<string, unknown>>(userId: string, orgId: string, sqlText: string, params: unknown[] = [], superadmin = false) => {
      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL ROLE app_runtime");
        await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`,
          [userId, orgId, superadmin ? "true" : "false"]);
        return { rows: (await c.query<T>(sqlText, params)).rows, error: null as string | null };
      } catch (e) { return { rows: [] as T[], error: (e as Error).message }; }
      finally { await c.query("ROLLBACK"); }
    };
    // A caregiver with an assignment, another member of the same agency, a relative.
    const worker = (await q<{ user_id: string; org: string; shift_id: string }>(`
      SELECT w.user_id, a.organization_id org, a.shift_id FROM assignments a
      JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id JOIN workers w ON w.id = m.worker_id
      JOIN shifts s ON s.id = a.shift_id WHERE s.status <> 'cancelled' LIMIT 1`))[0];
    if (!worker) { check("F0 data has an assigned caregiver to probe with", false, "none"); return results; }
    const other = (await q<{ user_id: string }>(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND status='active' AND user_id <> $2 LIMIT 1`, [worker.org, worker.user_id]))[0];
    const fam = (await q<{ user_id: string; org: string; id: string }>(`SELECT user_id, organization_id org, id FROM family_relationships WHERE status='active' LIMIT 1`))[0];

    const p1 = await asRuntime(worker.user_id, worker.org, `UPDATE users SET email = email WHERE id = $1 RETURNING 1`, [other?.user_id]);
    check("F1 a caregiver cannot change another member's account", p1.rows.length === 0, p1.error ?? `rows=${p1.rows.length}`);
    const p2 = await asRuntime(worker.user_id, worker.org, `UPDATE users SET password_hash = password_hash WHERE id = $1 RETURNING 1`, [worker.user_id]);
    check("F2 own password still updatable (reset flow)", p2.rows.length === 1, p2.error ?? `rows=${p2.rows.length}`);
    const p3 = await asRuntime(worker.user_id, worker.org, `UPDATE shifts SET scheduled_end = scheduled_end + interval '1 day' WHERE id = $1 RETURNING 1`, [worker.shift_id]);
    check("F3 a caregiver cannot move the hours of their shift", p3.rows.length === 0, p3.error ? p3.error.slice(0, 60) : `rows=${p3.rows.length}`);
    // F4 must probe an assignment that the pre-088 rules (migration 076) already
    // grant: pending/accepted, active membership, live shift (not ended, or in
    // progress with a check-in). Real data is mostly past/completed visits, which
    // 076 hides on purpose. The probe's row facts are printed as booleans only.
    const facts = (await q<Record<string, boolean | string>>(`
      SELECT a.response_status, s.status shift_status, owm.status = 'active' membership_active,
             s.scheduled_end > now() not_ended
      FROM assignments a JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
      JOIN shifts s ON s.id = a.shift_id WHERE a.shift_id = $1 AND owm.worker_id = (SELECT id FROM workers WHERE user_id = $2 LIMIT 1)`,
      [worker.shift_id, worker.user_id]))[0];
    console.log(`INFO  F4 first probed assignment: ${JSON.stringify(facts)}`);
    const live = (await q<{ user_id: string; org: string; shift_id: string }>(`
      SELECT w.user_id, a.organization_id org, a.shift_id FROM assignments a
      JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id JOIN workers w ON w.id = m.worker_id
      JOIN shifts s ON s.id = a.shift_id
      WHERE m.status = 'active' AND a.response_status IN ('pending','accepted')
        AND s.status IN ('unassigned','confirmed','in_progress') AND s.scheduled_end > now() LIMIT 1`))[0];
    if (live) {
      const p4 = await asRuntime(live.user_id, live.org, `SELECT 1 FROM shifts WHERE id = $1`, [live.shift_id]);
      check("F4 the caregiver still reads their live assigned shift", p4.rows.length === 1, p4.error ?? `rows=${p4.rows.length}`);
    } else {
      // No live assignment in this data: prove the deny is 076's rule, not 088's,
      // by asking the 076 helper directly for the probed row.
      const r = await asRuntime(worker.user_id, worker.org, `SELECT app_worker_has_shift_assignment($1) ok`, [worker.shift_id]);
      const helper = (r.rows[0] as { ok?: boolean } | undefined)?.ok;
      check("F4 no live assignment in this data: the probed row is hidden by migration 076's rule (helper=false), as before 088",
        helper === false && !r.error, r.error ?? `helper=${helper}`);
    }
    if (fam) {
      const p5 = await asRuntime(fam.user_id, fam.org, `UPDATE family_relationships SET can_view_photos = NOT can_view_photos WHERE id = $1 RETURNING 1`, [fam.id]);
      check("F5 a relative cannot change their own permissions", p5.rows.length === 0, p5.error ? p5.error.slice(0, 60) : `rows=${p5.rows.length}`);
      const p6 = await asRuntime(fam.user_id, fam.org, `SELECT count(*)::int n FROM family_relationships WHERE id = $1`, [fam.id]);
      check("F6 the relative still reads their own relationship", Number((p6.rows[0] as { n?: number })?.n) === 1, p6.error ?? "");
    }
    const tower = await asRuntime(worker.user_id, worker.org, `SELECT count(*)::int n FROM notifications WHERE user_id <> $1`, [worker.user_id], true);
    check("F7 a platform session reads no other user's notifications", Number((tower.rows[0] as { n?: number })?.n) === 0, tower.error ?? "");
    return results;
  } finally { await c.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const url = process.env.CHECK088_URL;
    if (!url) throw new Error("CHECK088_URL is required");
    const results = await check088(url, process.env.CHECK088_ALLOW_UNMARKED_COPY);
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
    const failed = results.filter((r) => !r.pass).length;
    console.log(`CHECK088 ${results.length - failed}/${results.length} PASS`);
    if (failed) process.exitCode = 1;
  })().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
