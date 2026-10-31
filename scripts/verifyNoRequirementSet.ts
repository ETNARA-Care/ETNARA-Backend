/**
 * Agencia nueva sin política de credenciales (auditoría integral, 30-oct-2026).
 *
 * Una agencia recién creada no tiene requisitos para sus puestos. Antes, asignar una cuidadora,
 * «Comenzar turno» y las recomendaciones de cobertura respondían 500 (NO_APPLICABLE_REQUIREMENT_SET
 * sin tratar). Ahora:
 *   - asignar y comenzar → 409 NO_APPLICABLE_REQUIREMENT_SET, sin guardar nada;
 *   - recomendaciones de cobertura → 200, la cuidadora aparece no recomendada con ese motivo;
 *   - en cuanto la agencia guarda su política, asignar funciona (201).
 * No crea ninguna política por defecto: eso es una decisión de producto.
 *
 * Datos sintéticos; solo bases desechables.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *   AUTHZ_DB_MODE=superuser|app_runtime npx tsx scripts/verifyNoRequirementSet.ts
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

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

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
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    return { status: res.status, json, text };
  };

  // Global requirement sets would hide the case; the probe needs none for this role.
  const role = `PUESTO-${tag}`;
  const globalSets = Number((await q(`SELECT count(*) FROM requirement_sets WHERE organization_id IS NULL AND (worker_role IS NULL OR lower(worker_role)=lower($1))`, [role]))[0].count);
  if (globalSets > 0) throw new Error("A global requirement set applies to every role; this probe needs a database without one");

  const org = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`NUEVA ${tag}`]))[0].id as string;
  const person = async (k: string, r: string, worker = false) => {
    const email = `nopol-${k}-${tag}@example.invalid`;
    const u = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash]))[0].id;
    const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [u, org]))[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, org, r]);
    let owm: string | undefined;
    if (worker) {
      const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Nueva') RETURNING id`, [u]))[0].id;
      owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active',$3) RETURNING id`, [w, org, role]))[0].id;
    }
    const login = await call("POST", "/auth/login", "", { email, password });
    return { token: login.json.token as string, owm };
  };
  const admin = await person("admin", "ORGANIZATION_ADMIN");
  const cg = await person("cg", "WORKER", true);
  const rec = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [org, `N-${tag}`]))[0].id;
  const shift = async (startMin: number, endMin: number) =>
    (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+make_interval(mins=>$3::int),now()+make_interval(mins=>$4::int),'confirmed') RETURNING id`, [org, rec, startMin, endMin]))[0].id as string;
  const A = `/organizations/${org}`;

  // 1. Assigning: clear 409, nothing saved.
  const s1 = await shift(24 * 60, 28 * 60);
  const asg = await call("POST", `${A}/shifts/${s1}/assignments`, admin.token, { organizationWorkerMembershipId: cg.owm });
  const asgRows = Number((await q(`SELECT count(*) FROM assignments WHERE shift_id=$1`, [s1]))[0].count);
  check("asignar sin política → 409 NO_APPLICABLE_REQUIREMENT_SET, nada guardado", asg.status === 409 && asg.json.error === "NO_APPLICABLE_REQUIREMENT_SET" && asgRows === 0, `${asg.status} ${asg.text.slice(0, 80)} filas=${asgRows}`);

  // 2. «Comenzar turno» on a shift she is already assigned to (assigned before the rule, or directly).
  const s2 = await shift(10, 4 * 60);
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status) VALUES ($1,$2,$3,$4,'accepted')`, [org, s2, cg.owm, rec]);
  const ci = await call("POST", `${A}/shifts/${s2}/check-in`, cg.token, { verificationMethodCode: "CAREGIVER_SESSION" });
  const ev = Number((await q(`SELECT count(*) FROM verification_events WHERE shift_id=$1`, [s2]))[0].count);
  check("comenzar sin política → 409 NO_APPLICABLE_REQUIREMENT_SET, nada guardado", ci.status === 409 && ci.json.error === "NO_APPLICABLE_REQUIREMENT_SET" && ev === 0, `${ci.status} ${ci.text.slice(0, 80)} eventos=${ev}`);

  // 3. Coverage recommendations still load; she is listed as not recommended, with the reason.
  const cov = await call("POST", `${A}/coverage/recommendations`, admin.token, {
    careRecipientId: rec, scheduledStart: new Date(Date.now() + 30 * 3600_000).toISOString(), scheduledEnd: new Date(Date.now() + 34 * 3600_000).toISOString(),
  });
  check("recomendaciones de cobertura sin política → 200, no recomendada y con el motivo", cov.status === 200 && cov.text.includes("NO_APPLICABLE_REQUIREMENT_SET") && !/"recommended":\s*true/.test(cov.text), `${cov.status} ${cov.text.slice(0, 120)}`);

  // 3b. Establishment route: creating a shift with a caregiver goes through the same assignment rule.
  const est = (await q(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [org, `Hogar ${tag}`]))[0].id;
  await q(`UPDATE care_recipients SET location_id=$1 WHERE id=$2`, [est, rec]);
  await q(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id,created_by_user_id)
           SELECT $1,$2,$3,u.id FROM users u WHERE u.email=$4`, [org, est, cg.owm, `nopol-admin-${tag}@example.invalid`]);
  const before = Number((await q(`SELECT count(*) FROM assignments WHERE organization_id=$1`, [org]))[0].count);
  const es = await call("POST", `${A}/establishments/${est}/shifts`, admin.token, {
    recipientId: rec, membershipId: cg.owm, scheduledStart: new Date(Date.now() + 50 * 3600_000).toISOString(), scheduledEnd: new Date(Date.now() + 54 * 3600_000).toISOString(),
  });
  const after = Number((await q(`SELECT count(*) FROM assignments WHERE organization_id=$1`, [org]))[0].count);
  check("establecimiento: crear turno con cuidadora sin política → 409, sin asignación", es.status === 409 && es.json.error === "NO_APPLICABLE_REQUIREMENT_SET" && after === before, `${es.status} ${es.text.slice(0, 80)} asignaciones ${before}→${after}`);

  // 4. Once the agency saves its policy, assigning works.
  const type = (await q(`SELECT code FROM credential_types ORDER BY code LIMIT 1`))[0].code;
  const pol = await call("PUT", `${A}/compliance/configuration`, admin.token, { workerRole: role, requirements: [{ credentialTypeCode: type, isMandatory: false, requiresOrganizationReview: false }] });
  const asg2 = await call("POST", `${A}/shifts/${s1}/assignments`, admin.token, { organizationWorkerMembershipId: cg.owm });
  check("tras guardar su política, asignar funciona (201)", pol.status === 200 && asg2.status === 201, `política=${pol.status} asignar=${asg2.status} ${asg2.text.slice(0, 80)}`);

  server.close(); await pool.end(); await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  console.log(`\n[${mode}] NO_REQUIREMENT_SET ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
