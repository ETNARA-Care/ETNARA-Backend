/**
 * C1 / C2 (auditoría 31-oct-2026): an establishment administrator cannot pull residents or caregivers
 * from elsewhere, nor change a caregiver's role, status or name. Agency managers can.
 *
 * HTTP part runs with the app connected as AUTHZ_DB_MODE=superuser (production today) or app_runtime.
 * The RLS part always connects as app_runtime and tries the same changes directly in SQL, with the
 * tenant context of each role, to prove the database refuses them even if the code did not.
 *
 * Synthetic data; disposable databases only.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *   AUTHZ_DB_MODE=superuser|app_runtime npx tsx scripts/verifyEstablishmentAgencyChanges.ts
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
  const rtPassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${rtPassword}'`);
  const rtUrl = new URL(adminUrl!); rtUrl.username = "app_runtime"; rtUrl.password = rtPassword;
  process.env.DATABASE_URL = mode === "app_runtime" ? rtUrl.toString() : adminUrl;
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

  // ---------------------------------------------------------------- fixtures
  const org = async (n: string) => (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`C1C2 ${n} ${tag}`]))[0].id as string;
  const A = await org("A"), B = await org("B");
  const person = async (k: string, o: string, role: string) => {
    const email = `c1c2-${k}-${tag}@example.invalid`;
    const u = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash]))[0].id as string;
    const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [u, o]))[0].id as string;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, o, role]);
    const login = await call("POST", "/auth/login", "", { email, password });
    return { userId: u, om, token: login.json.token as string };
  };
  const adminA = await person("admin-a", A, "ORGANIZATION_ADMIN");
  const supA = await person("sup-a", A, "SUPERVISOR");
  const est1 = await person("est1", A, "WORKER");   // establishment administrator of E1, not an agency manager
  const est2 = await person("est2", A, "WORKER");   // establishment administrator of E2
  const cg = await person("cg", A, "WORKER");       // plain caregiver (owns worker profile w1)
  const fam = await person("fam", A, "FAMILY");
  const adminB = await person("admin-b", B, "ORGANIZATION_ADMIN");

  const loc = async (o: string, n: string) => (await q(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [o, `${n} ${tag}`]))[0].id as string;
  const E1 = await loc(A, "Hogar Uno"), E2 = await loc(A, "Hogar Dos"), EB = await loc(B, "Hogar B");
  await q(`INSERT INTO establishment_admin_assignments (organization_id,location_id,organization_membership_id,created_by_user_id) VALUES ($1,$2,$3,$4),($1,$5,$6,$4)`, [A, E1, est1.om, adminA.userId, E2, est2.om]);

  const resident = async (o: string, l: string | null, n: string) => (await q(`INSERT INTO care_recipients (organization_id,location_id,first_name,last_name) VALUES ($1,$2,$3,'Prueba') RETURNING id`, [o, l, `${n}-${tag}`]))[0].id as string;
  const r1 = await resident(A, E1, "EnHogarUno"), r2 = await resident(A, E2, "EnHogarDos"), r3 = await resident(A, null, "Domiciliario"), r4 = await resident(A, null, "Domiciliario2"), rB = await resident(B, EB, "OtraAgencia");

  const caregiver = async (o: string, name: string, userId: string | null, l: string | null) => {
    const w = (await q(`INSERT INTO workers (display_name,user_id) VALUES ($1,$2) RETURNING id`, [`${name} ${tag}`, userId]))[0].id as string;
    const m = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CAREGIVER') RETURNING id`, [w, o]))[0].id as string;
    if (l) await q(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id,created_by_user_id) VALUES ($1,$2,$3,$4)`, [o, l, m, adminA.userId]);
    return { w, m };
  };
  const c1 = await caregiver(A, "Cuidadora E1", cg.userId, E1);   // in E1 (also the plain caregiver's own profile)
  const c2 = await caregiver(A, "Cuidadora E2", null, E2);        // in E2
  const c3 = await caregiver(A, "Cuidadora Domicilio", null, null); // home care, no establishment
  const cB = await caregiver(B, "Cuidadora B", null, null);

  const locOf = async (r: string) => (await q(`SELECT location_id FROM care_recipients WHERE id=$1`, [r]))[0].location_id as string | null;
  const mem = async (m: string) => (await q(`SELECT owm.status, owm.internal_role, w.display_name FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id WHERE owm.id=$1`, [m]))[0];
  const assigned = async (m: string, l: string) => Number((await q(`SELECT count(*) FROM establishment_worker_assignments WHERE organization_worker_membership_id=$1 AND location_id=$2 AND archived_at IS NULL`, [m, l]))[0].count);
  const audits = async (action: string, entity: string) => Number((await q(`SELECT count(*) FROM audit_log WHERE action=$1 AND entity_id=$2`, [action, entity]))[0].count);
  const P = (o: string, l: string) => `/organizations/${o}/establishments/${l}`;

  // ---------------------------------------------------------------- C1 residents (HTTP)
  {
    let r = await call("POST", `${P(A, E1)}/residents`, est1.token, { recipientId: r2 });
    check("C1.1 admin. de E1 trae a su establecimiento un residente de E2 → 403 RESIDENT_TRANSFER_FORBIDDEN, sigue en E2", r.status === 403 && r.json.error === "RESIDENT_TRANSFER_FORBIDDEN" && (await locOf(r2)) === E2, `${r.status} ${r.text.slice(0, 80)}`);
    r = await call("POST", `${P(A, E1)}/residents`, est1.token, { recipientId: r3 });
    check("C1.2 admin. de E1 trae un residente del servicio domiciliario → 403, sigue domiciliario", r.status === 403 && r.json.error === "RESIDENT_TRANSFER_FORBIDDEN" && (await locOf(r3)) === null, `${r.status}`);
    r = await call("POST", `${P(A, E1)}/residents`, est1.token, { recipientId: r1 });
    check("C1.3 admin. de E1 con un residente que ya está en E1 → 201 sin cambio ni auditoría", r.status === 201 && (await locOf(r1)) === E1 && (await audits("RESIDENT_ESTABLISHMENT_CHANGED", r1)) === 0, `${r.status}`);
    r = await call("POST", `${P(A, E2)}/residents`, est1.token, { recipientId: r1 });
    check("C1.4 admin. de E1 actuando sobre E2 (no lo administra) → 403, nada cambia", r.status === 403 && (await locOf(r1)) === E1, `${r.status} ${r.json.error}`);
    r = await call("POST", `${P(A, E1)}/residents`, cg.token, { recipientId: r3 });
    check("C1.5 cuidadora sin administración → 403, nada cambia", r.status === 403 && (await locOf(r3)) === null, `${r.status}`);
    r = await call("POST", `${P(A, E1)}/residents`, fam.token, { recipientId: r3 });
    check("C1.6 familia → 403, nada cambia", r.status === 403 && (await locOf(r3)) === null, `${r.status}`);
    r = await call("PATCH", `${P(A, E1)}/residents/${r2}`, est1.token, { firstName: "Cambiado" });
    check("C1.7 admin. de E1 edita un residente de E2 por su ruta → 404, nada cambia", r.status === 404 && (await q(`SELECT first_name FROM care_recipients WHERE id=$1`, [r2]))[0].first_name === `EnHogarDos-${tag}`, `${r.status}`);
    r = await call("POST", `${P(A, E1)}/residents`, adminB.token, { recipientId: r3 });
    check("C1.8 administradora de otra agencia → 403, nada cambia", r.status === 403 && (await locOf(r3)) === null, `${r.status}`);
    r = await call("POST", `${P(B, EB)}/residents`, adminB.token, { recipientId: r3 });
    check("C1.9 otra agencia intenta llevar un residente de A a su establecimiento → 404, nada cambia", r.status === 404 && (await locOf(r3)) === null, `${r.status}`);
    r = await call("POST", `${P(A, E1)}/residents`, adminA.token, { recipientId: r3 });
    check("C1.10 administradora de la agencia traslada un residente domiciliario a E1 → 201 y auditoría (origen vacío → E1)", r.status === 201 && (await locOf(r3)) === E1 && (await audits("RESIDENT_ESTABLISHMENT_CHANGED", r3)) === 1, `${r.status}`);
    r = await call("POST", `${P(A, E1)}/residents`, supA.token, { recipientId: r2 });
    const a = await q(`SELECT previous_value->>'location_id' AS f, new_value->>'location_id' AS t, actor_user_id FROM audit_log WHERE action='RESIDENT_ESTABLISHMENT_CHANGED' AND entity_id=$1`, [r2]);
    check("C1.11 supervisora traslada de E2 a E1 → 201; auditoría con origen E2, destino E1 y autora", r.status === 201 && (await locOf(r2)) === E1 && a.length === 1 && a[0].f === E2 && a[0].t === E1 && a[0].actor_user_id === supA.userId, `${r.status} ${JSON.stringify(a)}`);
    r = await call("POST", `${P(A, E1)}/residents/manage`, est1.token, { firstName: `Nuevo-${tag}`, lastName: "Residente" });
    const created = await q(`SELECT location_id FROM care_recipients WHERE first_name=$1`, [`Nuevo-${tag}`]);
    check("C1.12 admin. de E1 sigue pudiendo crear un residente nuevo en E1 → 201", r.status === 201 && created[0]?.location_id === E1, `${r.status}`);
  }

  // ---------------------------------------------------------------- C2 caregivers (HTTP)
  {
    let r = await call("POST", `${P(A, E1)}/personnel`, est1.token, { membershipId: c2.m });
    check("C2.1 admin. de E1 se adjudica una cuidadora de E2 → 403 ESTABLISHMENT_STAFF_ASSIGNMENT_FORBIDDEN, sin asignación", r.status === 403 && r.json.error === "ESTABLISHMENT_STAFF_ASSIGNMENT_FORBIDDEN" && (await assigned(c2.m, E1)) === 0, `${r.status} ${r.text.slice(0, 80)}`);
    r = await call("POST", `${P(A, E1)}/personnel`, est1.token, { membershipId: c3.m });
    check("C2.2 admin. de E1 se adjudica una cuidadora domiciliaria → 403, sin asignación", r.status === 403 && (await assigned(c3.m, E1)) === 0, `${r.status}`);
    r = await call("PATCH", `${P(A, E1)}/personnel/${c1.m}`, est1.token, { status: "inactive" });
    check("C2.3 admin. de E1 desactiva (en toda la agencia) a una cuidadora de E1 → 403 ESTABLISHMENT_STAFF_CHANGE_FORBIDDEN, sigue activa", r.status === 403 && r.json.error === "ESTABLISHMENT_STAFF_CHANGE_FORBIDDEN" && (await mem(c1.m)).status === "active", `${r.status} ${r.text.slice(0, 80)}`);
    r = await call("PATCH", `${P(A, E1)}/personnel/${c1.m}`, est1.token, { internalRole: "SUPERVISOR" });
    check("C2.4 escalamiento: admin. de E1 cambia el rol a SUPERVISOR → 403, rol intacto", r.status === 403 && (await mem(c1.m)).internal_role === "CAREGIVER", `${r.status}`);
    r = await call("PATCH", `${P(A, E1)}/personnel/${c1.m}`, est1.token, { displayName: "Nombre ajeno" });
    check("C2.5 admin. de E1 cambia el nombre global → 403, nombre intacto", r.status === 403 && (await mem(c1.m)).display_name === `Cuidadora E1 ${tag}`, `${r.status}`);
    r = await call("PATCH", `${P(A, E1)}/personnel/${c2.m}`, est1.token, { status: "inactive" });
    check("C2.6 admin. de E1 sobre una cuidadora de E2 → 403/404, sigue activa", [403, 404].includes(r.status) && (await mem(c2.m)).status === "active", `${r.status}`);
    r = await call("POST", `${P(A, E1)}/administrators`, est1.token, { membershipId: est1.om });
    check("C2.7 admin. de E1 se nombra a sí misma administradora (otra vez) → 403", r.status === 403, `${r.status}`);
    r = await call("PATCH", `/organizations/${A}/workers/${c1.m}`, est1.token, { status: "inactive" });
    check("C2.8 admin. de E1 por la ruta de agencia → 403, sigue activa", r.status === 403 && (await mem(c1.m)).status === "active", `${r.status}`);
    r = await call("PATCH", `${P(A, E1)}/personnel/${c1.m}`, cg.token, { internalRole: "SUPERVISOR" });
    check("C2.9 la propia cuidadora intenta subir su rol → 403, rol intacto", r.status === 403 && (await mem(c1.m)).internal_role === "CAREGIVER", `${r.status}`);
    r = await call("POST", `${P(A, E1)}/personnel`, adminB.token, { membershipId: c3.m });
    check("C2.10 otra agencia → 403, sin asignación", r.status === 403 && (await assigned(c3.m, E1)) === 0, `${r.status}`);
    // What stays allowed.
    r = await call("POST", `${P(A, E1)}/personnel/manage`, est1.token, { displayName: `Nueva ${tag}`, internalRole: "CNA" });
    const nm = r.json.person?.membership_id as string | undefined;
    check("C2.11 admin. de E1 crea una cuidadora NUEVA en E1 → 201, asignada a E1 y auditada", r.status === 201 && !!nm && (await assigned(nm!, E1)) === 1 && (await audits("ESTABLISHMENT_WORKER_CREATED", nm!)) === 1, `${r.status} ${r.text.slice(0, 120)}`);
    if (nm) {
      r = await call("PATCH", `${P(A, E1)}/personnel/${nm}`, est1.token, { internalRole: "SUPERVISOR" });
      check("C2.12 tampoco cambia el rol de la que acaba de crear → 403", r.status === 403 && (await mem(nm)).internal_role === "CNA", `${r.status}`);
    }
    r = await call("POST", `${P(A, E1)}/personnel/manage`, est2.token, { displayName: `Ajena ${tag}`, internalRole: "CNA" });
    check("C2.13 admin. de E2 no crea personal en E1 → 403", r.status === 403, `${r.status}`);
    r = await call("POST", `${P(A, E1)}/personnel`, adminA.token, { membershipId: c3.m });
    check("C2.14 administradora de la agencia asigna la cuidadora domiciliaria a E1 → 201", r.status === 201 && (await assigned(c3.m, E1)) === 1, `${r.status}`);
    r = await call("PATCH", `${P(A, E1)}/personnel/${c1.m}`, supA.token, { internalRole: "CNA" });
    check("C2.15 supervisora cambia el rol por la ruta del establecimiento → 200", r.status === 200 && (await mem(c1.m)).internal_role === "CNA", `${r.status}`);
    r = await call("PATCH", `${P(A, E1)}/personnel/${c1.m}`, adminA.token, { status: "inactive" });
    const off = (await mem(c1.m)).status;
    const r2b = await call("PATCH", `${P(A, E1)}/personnel/${c1.m}`, adminA.token, { status: "active" });
    check("C2.16 administradora desactiva y reactiva → 200 / 200", r.status === 200 && off === "inactive" && r2b.status === 200 && (await mem(c1.m)).status === "active", `${r.status} ${r2b.status}`);
  }

  server.close(); await pool.end();

  // ---------------------------------------------------------------- RLS: the same changes directly in SQL as app_runtime
  if (mode === "app_runtime") {
    const rt = new pg.Client({ connectionString: rtUrl.toString() }); await rt.connect();
    const as = async (who: { userId: string }, o: string, stmt: string, params: unknown[] = []) => {
      await rt.query("BEGIN");
      try {
        await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [who.userId, o]);
        const r = await rt.query(stmt, params); return { rows: r.rowCount ?? 0, data: r.rows, code: null as string | null };
      } catch (e) { return { rows: -1, data: [], code: (e as { code?: string }).code ?? "ERR" }; }
      finally { await rt.query("ROLLBACK"); }
    };
    // Fresh rows so these checks do not depend on the HTTP part above.
    const d1 = await caregiver(A, "Rls E1", null, E1), d2 = await caregiver(A, "Rls E2", null, E2);
    let x = await as(est1, A, `UPDATE care_recipients SET location_id=$1 WHERE id=$2`, [E1, r4]);
    check("R1 RLS: admin. de E1 mueve en SQL un residente domiciliario a E1 → 0 filas", x.rows === 0, JSON.stringify(x));
    const r5 = await resident(A, E2, "EnHogarDosB");
    x = await as(est1, A, `UPDATE care_recipients SET location_id=$1 WHERE id=$2`, [E1, r5]);
    check("R2 RLS: admin. de E1 mueve en SQL un residente de E2 → 0 filas", x.rows === 0, JSON.stringify(x));
    x = await as(est1, A, `UPDATE care_recipients SET location_id=NULL WHERE id=$1`, [r1]);
    check("R3 RLS: admin. de E1 saca a un residente de E1 hacia domicilio → rechazado", x.rows <= 0, JSON.stringify(x));
    x = await as(est1, A, `INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id,created_by_user_id) VALUES ($1,$2,$3,$4)`, [A, E1, d2.m, est1.userId]);
    check("R4 RLS: admin. de E1 se asigna en SQL una cuidadora de E2 → 42501", x.code === "42501", JSON.stringify(x));
    x = await as(est1, A, `UPDATE establishment_worker_assignments SET location_id=$1 WHERE organization_worker_membership_id=$2`, [E1, d2.m]);
    check("R5 RLS: admin. de E1 mueve en SQL la asignación de E2 a E1 → 0 filas", x.rows === 0, JSON.stringify(x));
    x = await as(est1, A, `UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [d1.m]);
    check("R6 RLS: admin. de E1 desactiva en SQL una cuidadora → 0 filas", x.rows === 0, JSON.stringify(x));
    x = await as(est1, A, `UPDATE organization_worker_memberships SET internal_role='SUPERVISOR' WHERE id=$1`, [d1.m]);
    check("R7 RLS: admin. de E1 sube el rol en SQL → 0 filas", x.rows === 0, JSON.stringify(x));
    x = await as(est1, A, `INSERT INTO organization_worker_memberships (worker_id,organization_id,internal_role) VALUES ($1,$2,'CNA')`, [cB.w, A]);
    check("R8 RLS: admin. de E1 vincula en SQL a una cuidadora de otra agencia → rechazado", x.code === "42501", JSON.stringify(x));
    x = await as(est1, A, `UPDATE workers SET display_name='X' WHERE id=$1`, [d1.w]);
    check("R9 RLS: admin. de E1 cambia en SQL el nombre global → 0 filas", x.rows === 0, JSON.stringify(x));
    x = await as(fam, A, `UPDATE workers SET display_name='X' WHERE id=$1`, [d2.w]);
    check("R10 RLS: un familiar cambia en SQL el nombre de una cuidadora → 0 filas (antes: 1)", x.rows === 0, JSON.stringify(x));
    x = await as(cg, A, `UPDATE workers SET display_name='X' WHERE id=$1`, [d2.w]);
    check("R11 RLS: una cuidadora cambia en SQL el nombre de otra → 0 filas (antes: 1)", x.rows === 0, JSON.stringify(x));
    x = await as(cg, A, `UPDATE workers SET display_name=display_name WHERE id=$1`, [c1.w]);
    check("R12 RLS: la cuidadora actualiza su propio perfil → 1 fila", x.rows === 1, JSON.stringify(x));
    x = await as(adminA, A, `UPDATE workers SET display_name=display_name WHERE id=$1`, [d2.w]);
    check("R13 RLS: la administradora de la agencia actualiza el perfil → 1 fila", x.rows === 1, JSON.stringify(x));
    x = await as(adminA, A, `UPDATE organization_worker_memberships SET internal_role=internal_role WHERE id=$1`, [d2.m]);
    check("R14 RLS: la administradora actualiza la membresía → 1 fila", x.rows === 1, JSON.stringify(x));
    x = await as(est1, A, `SELECT * FROM app_establishment_create_worker($1,'Prueba','CNA')`, [E2]);
    check("R15 función: admin. de E1 crea personal en E2 → 42501", x.code === "42501", JSON.stringify(x));
    x = await as(cg, A, `SELECT * FROM app_establishment_create_worker($1,'Prueba','CNA')`, [E1]);
    check("R16 función: cuidadora sin administración → 42501", x.code === "42501", JSON.stringify(x));
    x = await as(est1, B, `SELECT * FROM app_establishment_create_worker($1,'Prueba','CNA')`, [EB]);
    check("R17 función: con el contexto de otra agencia → 42501", x.code === "42501" || x.code === "ERR" || x.rows <= 0, JSON.stringify(x));
    x = await as(est1, A, `SELECT * FROM app_establishment_create_worker($1,'Prueba','CNA')`, [E1]);
    check("R18 función: admin. de E1 crea personal en E1 → 1 fila", x.rows === 1, JSON.stringify(x));
    await rt.end();
  }
  await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  console.log(`\n[${mode}] ESTABLISHMENT_AGENCY_CHANGES ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
