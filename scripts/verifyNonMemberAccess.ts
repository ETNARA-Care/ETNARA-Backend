/**
 * Non-member access guard (auditoría B4, 27-oct-2026).
 *
 * Walks EVERY route registered in Express under /organizations/:organizationId
 * and calls it as an authenticated user who is NOT a member of that agency,
 * with real ids of that agency in the other path parameters. Each answer must be:
 *   - never 2xx (no data, no write), and
 *   - never 5xx (a refusal is not a server failure; it used to be 500 on
 *     documents, coverage offers, operations and agent briefings).
 * It also proves the agency's rows are unchanged afterwards.
 *
 * The app connects in the mode given by AUTHZ_DB_MODE (superuser = production
 * today, RLS bypassed; app_runtime = RLS applies). Synthetic data only,
 * disposable databases only.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *   AUTHZ_DB_MODE=superuser|app_runtime npx tsx scripts/verifyNonMemberAccess.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
const mode = process.env.AUTHZ_DB_MODE ?? "superuser";
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");
if (mode !== "superuser" && mode !== "app_runtime") throw new Error("AUTHZ_DB_MODE must be superuser or app_runtime");

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows;

  if (mode === "app_runtime") {
    const pw = randomBytes(24).toString("hex");
    await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
    const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = pw;
    process.env.DATABASE_URL = u.toString();
  } else process.env.DATABASE_URL = adminUrl;

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const tag = randomUUID().slice(0, 8);
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);

  // Victim agency with one object of each common kind; attacker = admin of another agency.
  const orgA = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`NONMEMBER A ${tag}`]))[0].id;
  const orgB = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`NONMEMBER B ${tag}`]))[0].id;
  for (const f of ["SMARTMATCH", "EN_CAMINO", "ACTIVITY_PHOTOS", "SHIFT_REPORTS", "FINANZAS"]) {
    await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,$2,true),($3,$2,true) ON CONFLICT DO NOTHING`, [orgA, f, orgB]);
  }
  const user = async (email: string, org: string, role: string, worker = false) => {
    const id = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash]))[0].id;
    const m = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [id, org]))[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [m, org, role]);
    let owm: string | undefined;
    if (worker) {
      const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Sintetica') RETURNING id`, [id]))[0].id;
      owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, org]))[0].id;
    }
    return { id, m, owm };
  };
  const adminA = await user(`nonmember-admin-a-${tag}@example.invalid`, orgA, "ORGANIZATION_ADMIN");
  const cgA = await user(`nonmember-cg-a-${tag}@example.invalid`, orgA, "WORKER", true);
  const attackerEmail = `nonmember-admin-b-${tag}@example.invalid`;
  await user(attackerEmail, orgB, "ORGANIZATION_ADMIN");
  const loc = (await q(`INSERT INTO locations (organization_id,name) VALUES ($1,'Hogar A') RETURNING id`, [orgA]))[0].id;
  const rec = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name,location_id) VALUES ($1,'Sintetico','A',$2) RETURNING id`, [orgA, loc]))[0].id;
  const shift = (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+interval '1 day',now()+interval '1 day 4 hours','confirmed') RETURNING id`, [orgA, rec]))[0].id;
  const asg = (await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,role_in_shift,response_status) VALUES ($1,$2,$3,$4,'caregiver','accepted') RETURNING id`, [orgA, shift, cgA.owm, rec]))[0].id;
  const inc = (await q(`INSERT INTO incidents (organization_id,care_recipient_id,organization_worker_membership_id,severity,description) VALUES ($1,$2,$3,'low','sintetico') RETURNING id`, [orgA, rec, cgA.owm]))[0].id;
  const obs = (await q(`INSERT INTO observations (organization_id,care_recipient_id,organization_worker_membership_id,category,description) VALUES ($1,$2,$3,'pain','sintetica') RETURNING id`, [orgA, rec, cgA.owm]))[0].id;
  const thread = (await q(`INSERT INTO message_threads (organization_id,care_recipient_id,thread_type) VALUES ($1,$2,'family_agency') RETURNING id`, [orgA, rec]))[0].id;
  await q(`INSERT INTO message_thread_participants (organization_id,message_thread_id,user_id,can_write) VALUES ($1,$2,$3,true)`, [orgA, thread, adminA.id]);

  const ids: Record<string, string> = {
    organizationId: orgA, recipientId: rec, careRecipientId: rec, shiftId: shift, establishmentId: loc, locationId: loc,
    membershipId: cgA.owm!, workerId: cgA.owm!, assignmentId: asg, incidentId: inc, observationId: obs, conversationId: thread,
  };
  const fingerprint = async () => {
    const tables = (await q(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='organization_id'
      INTERSECT SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='id'`)).map((r) => r.table_name as string);
    const out: string[] = [];
    for (const t of tables.sort()) out.push(`${t}:${(await q(`SELECT md5(coalesce(string_agg(md5(x::text), ',' ORDER BY md5(x::text)),'')) h FROM ${t} x WHERE organization_id=$1`, [orgA]))[0].h}`);
    return out;
  };
  const before = await fingerprint();

  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: attackerEmail, password }) });
  const token = ((await login.json()) as { token: string }).token;

  const routes: { method: string; path: string }[] = [];
  const walk = (stack: any[]) => {
    for (const l of stack ?? []) {
      if (l.route) for (const m of Object.keys(l.route.methods)) { if (typeof l.route.path === "string") routes.push({ method: m.toUpperCase(), path: l.route.path }); }
      else if (l.handle?.stack) walk(l.handle.stack);
    }
  };
  walk((app as any).router?.stack ?? (app as any)._router?.stack);
  const orgRoutes = routes.filter((r) => r.path.startsWith("/organizations/:organizationId"));
  if (orgRoutes.length < 150) throw new Error(`route discovery found only ${orgRoutes.length} organization routes`);

  const failures: string[] = [];
  for (const r of orgRoutes) {
    const path = r.path.replace(/:([A-Za-z]+)/g, (_, n) => ids[n] ?? randomUUID());
    let res = await fetch(base + path, { method: r.method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: r.method === "GET" || r.method === "DELETE" ? undefined : "{}" });
    if (res.status === 429) {
      await new Promise((ok) => setTimeout(ok, 61_000));
      res = await fetch(base + path, { method: r.method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: r.method === "GET" || r.method === "DELETE" ? undefined : "{}" });
    }
    await res.arrayBuffer();
    const ok = res.status >= 400 && res.status < 500;
    if (!ok) failures.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  const after = await fingerprint();
  const changed = before.filter((x, i) => x !== after[i]);

  console.log(`NONMEMBER_ACCESS mode=${mode} routes=${orgRoutes.length} failures=${failures.length} victim_tables_changed=${changed.length}`);
  for (const f of failures) console.log(`FAIL  ${f}`);
  for (const c of changed) console.log(`FAIL  agency A changed: ${c.split(":")[0]}`);
  server.close(); await pool.end(); await db.end();
  if (failures.length || changed.length) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
