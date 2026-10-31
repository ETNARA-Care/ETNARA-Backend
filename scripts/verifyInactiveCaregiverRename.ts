/**
 * Cambiar el nombre de una cuidadora con la membresía INACTIVA (decisión de Rafa, 30-oct-2026).
 *
 * La agencia donde está inactiva no edita su nombre: error explícito 409 WORKER_MEMBERSHIP_INACTIVE
 * y nada se guarda, en ambos modos de base de datos (antes, con app_runtime respondía 200 sin
 * guardar; con superusuario lo guardaba). Comprueba también:
 *   - editar el puesto u otros datos de una inactiva, mandando el mismo nombre, sigue funcionando;
 *   - reactivar y renombrar en la misma petición funciona y guarda;
 *   - una agencia donde sigue ACTIVA puede renombrarla (el perfil es compartido);
 *   - la ruta de establecimientos aplica la misma regla y ya no borra la fecha de baja al editar;
 *   - otra agencia no puede tocarla.
 *
 * Datos sintéticos; solo bases desechables.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *   AUTHZ_DB_MODE=superuser|app_runtime npx tsx scripts/verifyInactiveCaregiverRename.ts
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

  const org = async (n: string) => (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`RENAME ${n} ${tag}`]))[0].id as string;
  const A = await org("A"), B = await org("B"), C = await org("C");
  const person = async (k: string, o: string, role: string) => {
    const email = `rename-${k}-${tag}@example.invalid`;
    const u = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash]))[0].id;
    const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [u, o]))[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, o, role]);
    const login = await call("POST", "/auth/login", "", { email, password });
    return { userId: u as string, om: om as string, token: login.json.token as string };
  };
  const adminA = await person("admin-a", A, "ORGANIZATION_ADMIN");
  const supA = await person("sup-a", A, "SUPERVISOR");
  const adminB = await person("admin-b", B, "ORGANIZATION_ADMIN");
  const adminC = await person("admin-c", C, "ORGANIZATION_ADMIN");

  // The caregiver: INACTIVE in A (with the date she left), ACTIVE in B. Same worker profile.
  const NAME = `Original ${tag}`;
  const w = (await q(`INSERT INTO workers (display_name) VALUES ($1) RETURNING id`, [NAME]))[0].id as string;
  const leftAt = "2026-10-01T12:00:00Z";
  const owmA = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role,ended_at) VALUES ($1,$2,'inactive','CNA',$3) RETURNING id`, [w, A, leftAt]))[0].id as string;
  const owmB = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','HHA') RETURNING id`, [w, B]))[0].id as string;
  const nameNow = async () => (await q(`SELECT display_name FROM workers WHERE id=$1`, [w]))[0].display_name as string;
  const membership = async (id: string) => (await q(`SELECT status, internal_role, ended_at FROM organization_worker_memberships WHERE id=$1`, [id]))[0];
  const PA = `/organizations/${A}/workers/${owmA}`;

  // 1. Agency A (inactive there): rename refused, explicit, nothing saved.
  for (const [who, t] of [["administradora", adminA.token], ["supervisora", supA.token]] as const) {
    const r = await call("PATCH", PA, t, { displayName: `Cambio ${who}` });
    check(`${who} de A: renombrar a la inactiva → 409 WORKER_MEMBERSHIP_INACTIVE`, r.status === 409 && r.json.error === "WORKER_MEMBERSHIP_INACTIVE", `${r.status} ${r.text.slice(0, 80)}`);
    check(`${who} de A: el nombre no cambió`, (await nameNow()) === NAME, await nameNow());
  }
  // 2. Editing other fields with the same name (what the portal sends) still works.
  {
    const r = await call("PATCH", PA, adminA.token, { displayName: NAME, internalRole: "HHA", hiredAt: "2025-01-15" });
    const m = await membership(owmA);
    check("A: editar puesto de la inactiva con el mismo nombre → 200 y se guarda", r.status === 200 && m.internal_role === "HHA", `${r.status} ${m.internal_role}`);
    check("A: sigue inactiva y conserva la fecha de baja", m.status === "inactive" && new Date(m.ended_at).toISOString() === new Date(leftAt).toISOString(), JSON.stringify(m));
  }
  // 3. Deactivate + rename in one request: refused, nothing saved (B keeps her active).
  {
    const r = await call("PATCH", `/organizations/${B}/workers/${owmB}`, adminB.token, { status: "inactive", displayName: "Baja y cambio" });
    check("B: desactivar y renombrar a la vez → 409, nada guardado", r.status === 409 && (await nameNow()) === NAME && (await membership(owmB)).status === "active", `${r.status}`);
  }
  // 4. Agency B (active there) may rename: shared profile.
  const NAME_B = `Desde B ${tag}`;
  {
    const r = await call("PATCH", `/organizations/${B}/workers/${owmB}`, adminB.token, { displayName: NAME_B });
    check("B (activa allí): renombra → 200 y se guarda", r.status === 200 && r.json.membership?.display_name === NAME_B && (await nameNow()) === NAME_B, `${r.status} ${await nameNow()}`);
  }
  // 5. Other agency C (no relation): nothing.
  {
    const r = await call("PATCH", `/organizations/${C}/workers/${owmA}`, adminC.token, { displayName: "Ajena" });
    check("C (sin relación): no la toca", [403, 404].includes(r.status) && (await nameNow()) === NAME_B, `${r.status}`);
  }
  // 6. Establishment route in A: same rule; editing the role no longer clears the date she left.
  {
    const est = (await q(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [A, `Hogar ${tag}`]))[0].id;
    await q(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id,created_by_user_id) VALUES ($1,$2,$3,$4)`, [A, est, owmA, adminA.userId]);
    const PE = `/organizations/${A}/establishments/${est}/personnel/${owmA}`;
    const r = await call("PATCH", PE, adminA.token, { displayName: "Por establecimiento" });
    check("establecimiento A: renombrar a la inactiva → 409, nada guardado", r.status === 409 && r.json.error === "WORKER_MEMBERSHIP_INACTIVE" && (await nameNow()) === NAME_B, `${r.status} ${r.text.slice(0, 80)}`);
    const r2 = await call("PATCH", PE, adminA.token, { internalRole: "CNA" });
    const m = await membership(owmA);
    check("establecimiento A: editar el puesto de la inactiva → 200, conserva la fecha de baja", r2.status === 200 && m.internal_role === "CNA" && m.status === "inactive" && m.ended_at !== null && new Date(m.ended_at).toISOString() === new Date(leftAt).toISOString(), `${r2.status} ${JSON.stringify(m)}`);
  }
  // 7. Reactivate + rename in one request (agency A): works and saves, in both modes.
  {
    const NAME_A = `Reactivada ${tag}`;
    const r = await call("PATCH", PA, supA.token, { status: "active", endedAt: null, displayName: NAME_A });
    const m = await membership(owmA);
    check("A: reactivar y renombrar a la vez → 200, activa y nombre guardado", r.status === 200 && m.status === "active" && (await nameNow()) === NAME_A, `${r.status} ${m.status} ${await nameNow()}`);
    const audits = Number((await q(`SELECT count(*) FROM audit_log WHERE action='WORKER_MEMBERSHIP_STATUS_CHANGED' AND entity_id=$1`, [owmA]))[0].count);
    check("A: la reactivación quedó auditada", audits === 1, `${audits}`);
  }

  server.close(); await pool.end(); await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  console.log(`\n[${mode}] INACTIVE_CAREGIVER_RENAME ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
