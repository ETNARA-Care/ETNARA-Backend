/**
 * 160 · Cuidador independiente como tercera modalidad (PR A: ETNARA Central y activación). 23-nov-2026.
 * Datos FICTICIOS, base PROPIA desechable, ningún correo real (Resend interceptado). App real por HTTP como app_runtime.
 * Cubre: modalidad apagada por defecto (Central y base), encendido solo por operación, creación desde Central,
 * activación con una sola cuenta (ADMIN + WORKER, perfil nuevo o perfil existente reutilizado como en la 159),
 * una sola persona operativa (base de datos y backend), rutas de equipo cerradas, tipo inmutable y su procedimiento,
 * y NO REGRESIÓN de agencias y hogares (invitaciones, personal, supervisoras, activación, ciclo de vida, rutas).
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

const mails: Array<{ to: string; html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const b = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, html: String(b.html ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";
process.env.ACTIVATION_BASE_URL ??= "https://portal.example.invalid";

async function main() {
  const own = `etnara_i160_${randomBytes(4).toString("hex")}`;
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  await srv.query(`CREATE DATABASE ${own}`);
  const ownUrl = new URL(serverUrl!); ownUrl.pathname = `/${own}`; const adminUrl = ownUrl.toString();
  { const m = new pg.Client({ connectionString: adminUrl }); await m.connect(); const log = console.log; console.log = () => undefined;
    try { await applyPendingMigrations(m, join(process.cwd(), "migrations")); } finally { console.log = log; await m.end(); } }
  const db = new pg.Client({ connectionString: adminUrl }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const rt = new pg.Client({ connectionString: u.toString() }); await rt.connect();
  const rtErr = async (s: string, p: unknown[] = []) => { try { await rt.query(s, p); return "OK"; } catch (e) { return (e as Error).message; } };
  const suErr = async (s: string, p: unknown[] = []) => { try { await q(s, p); return "OK"; } catch (e) { return (e as Error).message; } };

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const errors500: string[] = [];
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let json: Json = {}; try { json = JSON.parse(await res.text()); } catch { /* vacío */ }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status}`);
    return { status: res.status, body: json };
  }
  const org = async (name: string, type: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [name, type])).rows[0].id;
  const user = async (key: string) => { const email = `i160-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); return m; };
  const login = async (x: { email: string }, o?: string) => { const t = (await call("POST", "/auth/login", "", { email: x.email, password })).body.token as string; if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };
  const rolesOf = async (x: { id: string }, o: string) => (await q<{ c: string | null }>(`SELECT string_agg(r.code, ',' ORDER BY r.code) c FROM organization_memberships om JOIN user_roles ur ON ur.organization_membership_id=om.id JOIN roles r ON r.id=ur.role_id WHERE om.user_id=$1 AND om.organization_id=$2`, [x.id, o])).rows[0].c ?? "";
  const tokenFor = (email: string) => { const m = [...mails].reverse().find((x) => x.to === email); return /token=([a-f0-9]{64})/i.exec(m?.html ?? "")?.[1] ?? ""; };
  const snapshot = async (o: string) => (await q<{ s: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(id::text||status::text||internal_role||worker_id::text, ',' ORDER BY id) FROM organization_worker_memberships WHERE organization_id=$1),
      (SELECT string_agg(om.id::text||om.status::text||ur.role_id::text, ',' ORDER BY om.id, ur.role_id) FROM organization_memberships om LEFT JOIN user_roles ur ON ur.organization_membership_id=om.id WHERE om.organization_id=$1),
      (SELECT organization_type::text||status::text FROM organizations WHERE id=$1))) s`, [o])).rows[0].s;

  // Base ficticia: una agencia, un hogar, ETNARA Central.
  const A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY"), H = await org(`Hogar Ficticio ${tag}`, "RESIDENTIAL_CARE_HOME");
  const adminA = await user("admin-agencia"); await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const adminH = await user("admin-hogar"); await member(adminH, H, ["ORGANIZATION_ADMIN"]);
  const central = await user("central"); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const tC = await login(central), tA = await login(adminA, A), tH = await login(adminH, H);

  // ---- Modalidad apagada por defecto ---------------------------------------------------------------------
  const types0 = await call("GET", "/platform/organization-types", tC);
  const ind0 = (types0.body.types ?? []).find((t: Json) => t.code === "INDEPENDENT_PROVIDER");
  check("I1. Central: «Cuidador independiente» figura como NO disponible (modalidad apagada por defecto)", types0.status === 200 && ind0?.available === false, types0.body);
  const c0 = await call("POST", "/platform/organizations", tC, { name: `Independiente Ficticia ${tag}`, organizationType: "INDEPENDENT_PROVIDER" });
  check("I2. Central no crea un independiente con la modalidad apagada (409 INDEPENDENT_MODALITY_DISABLED)", c0.status === 409 && c0.body.error === "INDEPENDENT_MODALITY_DISABLED", c0);
  check("I3. La base lo impide también, aunque se salte el backend (app_runtime y superusuario)",
    (await rtErr(`INSERT INTO organizations (name,organization_type,status) VALUES ('x','INDEPENDENT_PROVIDER','active')`)).includes("INDEPENDENT_MODALITY_DISABLED")
    && (await suErr(`INSERT INTO organizations (name,organization_type,status) VALUES ('x','INDEPENDENT_PROVIDER','active')`)).includes("INDEPENDENT_MODALITY_DISABLED"));
  check("I4. La aplicación (app_runtime) no puede encender la modalidad", (await rtErr(`UPDATE platform_modalities SET enabled=true`)).includes("permission denied")
    && (await rtErr(`SELECT * FROM platform_modalities`)).includes("permission denied"));
  const cA = await call("POST", "/platform/organizations", tC, { name: `Agencia Nueva ${tag}`, organizationType: "HOME_CARE_AGENCY" });
  const cH = await call("POST", "/platform/organizations", tC, { name: `Hogar Nuevo ${tag}`, organizationType: "RESIDENTIAL_CARE_HOME" });
  check("N1. No regresión: Central sigue creando agencias y hogares", cA.status === 201 && cH.status === 201 && cA.body.organization?.organization_type === "HOME_CARE_AGENCY" && cH.body.organization?.organization_type === "RESIDENTIAL_CARE_HOME", [cA.status, cH.status]);

  // ---- Encendido por operación (solo en esta base desechable) ---------------------------------------------
  // 163: encender exige una autorización de activación vigente (segundo candado), también para el propietario.
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','verificador local','Prueba local con datos ficticios (163: candado)',5)`); 
  await q(`UPDATE platform_modalities SET enabled=true, updated_at=now() WHERE code='INDEPENDENT_PROVIDER'`);
  const types1 = await call("GET", "/platform/organization-types", tC);
  const c1 = await call("POST", "/platform/organizations", tC, { name: `Independiente Ficticia ${tag}`, organizationType: "INDEPENDENT_PROVIDER" });
  const I = c1.body.organization?.id as string;
  check("I5. Encendida por operación: Central la ofrece y crea la organización independiente", types1.body.types?.find((t: Json) => t.code === "INDEPENDENT_PROVIDER")?.available === true && c1.status === 201 && c1.body.organization?.organization_type === "INDEPENDENT_PROVIDER", c1);
  const noAdmin = await call("POST", "/platform/organizations", tA, { name: "Intento de agencia", organizationType: "INDEPENDENT_PROVIDER" });
  const noTypes = await call("GET", "/platform/organization-types", tA);
  check("I6. Solo ETNARA Central crea organizaciones o consulta las modalidades (una administradora de agencia, no)", noAdmin.status === 403 && noTypes.status === 403, [noAdmin.status, noTypes.status]);

  // ---- Activación con una sola cuenta: persona nueva --------------------------------------------------------
  const indEmail = `i160-independiente-${tag}@example.invalid`;
  const inv1 = await call("POST", `/platform/organizations/${I}/admin-invitations`, tC, { email: indEmail });
  const act1 = await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(indEmail), password });
  const ind = { email: indEmail, id: (await q<{ id: string }>(`SELECT id FROM users WHERE lower(email)=$1`, [indEmail])).rows[0]?.id ?? "" };
  const prof1 = await q<{ n: string }>(`SELECT count(*) n FROM workers WHERE user_id=$1`, [ind.id]);
  const mem1 = await q<{ status: string; internal_role: string; worker_user: string }>(`SELECT m.status, m.internal_role, w.user_id worker_user FROM organization_worker_memberships m JOIN workers w ON w.id=m.worker_id WHERE m.organization_id=$1`, [I]);
  const aud1 = await q<{ v: Json }>(`SELECT new_value v FROM audit_log WHERE action='INDEPENDENT_OPERATOR_PROVISIONED' AND organization_id=$1`, [I]);
  check("I7. Persona nueva: una sola cuenta activa como ORGANIZATION_ADMIN y WORKER, con perfil propio y su ficha de cuidadora activa",
    inv1.status === 201 && act1.status === 201 && (await rolesOf(ind, I)) === "ORGANIZATION_ADMIN,WORKER" && prof1.rows[0].n === "1"
    && mem1.rows.length === 1 && mem1.rows[0].status === "active" && mem1.rows[0].internal_role === "INDEPENDENT_CAREGIVER" && mem1.rows[0].worker_user === ind.id,
    [inv1.status, act1.status, act1.body, await rolesOf(ind, I), mem1.rows]);
  check("I8. Auditoría de la activación (INDEPENDENT_OPERATOR_PROVISIONED, perfil creado)", aud1.rows.length === 1 && aud1.rows[0].v.profileCreated === true, aud1.rows);
  const tI = await login(ind, I);
  const me = await call("GET", "/me", tI);
  const myOrg = (me.body.organizations ?? me.body.memberships ?? []).find((o: Json) => (o.id ?? o.organizationId ?? o.organization_id) === I);
  check("I9. /me identifica la organización como INDEPENDENT_PROVIDER con ambos roles (el portal lo usará en el PR B)",
    me.status === 200 && JSON.stringify(me.body).includes("INDEPENDENT_PROVIDER") && JSON.stringify(myOrg ?? me.body).includes("WORKER"), me.body);

  // ---- Persona que ya tiene perfil en una agencia (lógica de la 159) --------------------------------------
  const ana = await user("ana-cuidadora-agencia");
  const anaWorker = (await q<{ id: string }>(`INSERT INTO workers (user_id) VALUES ($1) RETURNING id`, [ana.id])).rows[0].id;
  await member(ana, A, ["WORKER"]);
  const anaMemA = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [anaWorker, A])).rows[0].id;
  const credType = (await q<{ id: string }>(`SELECT id FROM credential_types ORDER BY code LIMIT 1`)).rows[0].id;
  await q(`INSERT INTO credentials (worker_id, credential_type_id, issuing_entity_type, status) SELECT $1,$2,(enum_range(NULL::issuing_entity_type_enum))[1],'active'`, [anaWorker, credType]);
  const beforeA = await snapshot(A);
  const c2 = await call("POST", "/platform/organizations", tC, { name: `Ana Independiente ${tag}`, organizationType: "INDEPENDENT_PROVIDER" });
  const I2 = c2.body.organization.id as string;
  await call("POST", `/platform/organizations/${I2}/admin-invitations`, tC, { email: ana.email });
  const acc2 = await call("POST", "/platform/admin-invitations/accept", await login(ana), { token: tokenFor(ana.email) });
  const prof2 = await q<{ n: string }>(`SELECT count(*) n FROM workers WHERE user_id=$1`, [ana.id]);
  const mem2 = await q<{ worker_id: string }>(`SELECT worker_id FROM organization_worker_memberships WHERE organization_id=$1`, [I2]);
  const cred2 = await q<{ n: string }>(`SELECT count(*) n FROM credentials WHERE worker_id=$1`, [anaWorker]);
  const aud2 = await q<{ v: Json }>(`SELECT new_value v FROM audit_log WHERE action='INDEPENDENT_OPERATOR_PROVISIONED' AND organization_id=$1`, [I2]);
  check("I10. Persona con perfil en una agencia: se REUTILIZA su perfil único (sin perfil duplicado ni credenciales tocadas)",
    acc2.status === 201 && prof2.rows[0].n === "1" && mem2.rows.length === 1 && mem2.rows[0].worker_id === anaWorker && cred2.rows[0].n === "1" && aud2.rows[0]?.v.profileCreated === false,
    [acc2.status, acc2.body, prof2.rows, mem2.rows, aud2.rows]);
  check("I11. Su agencia no cambia: misma ficha, mismos roles, mismo estado", (await snapshot(A)) === beforeA
    && (await q(`SELECT 1 FROM organization_worker_memberships WHERE id=$1 AND status='active' AND organization_id=$2`, [anaMemA, A])).rowCount === 1 && (await rolesOf(ana, A)) === "WORKER");

  // ---- Una sola persona operativa -------------------------------------------------------------------------
  const second = await call("POST", `/platform/organizations/${I}/admin-invitations`, tC, { email: `i160-segunda-${tag}@example.invalid` });
  check("I12. Central no invita a una segunda administradora a un independiente (409 INDEPENDENT_SINGLE_OPERATOR, sin correo)",
    second.status === 409 && second.body.error === "INDEPENDENT_SINGLE_OPERATOR" && !mails.some((m) => m.to === `i160-segunda-${tag}@example.invalid`), second);
  const r1 = await call("GET", `/organizations/${I}/team`, tI);
  const r2 = await call("POST", `/organizations/${I}/team/invitations`, tI, { email: `i160-sup-${tag}@example.invalid`, role: "SUPERVISOR" });
  const r3 = await call("POST", `/organizations/${I}/workers`, tI, { displayName: "Ficha Provisional", internalRole: "CNA" });
  check("I13. Backend: equipo, supervisoras y fichas de personal cerrados en el independiente (403 MODALITY_NOT_AVAILABLE)",
    [r1, r2, r3].every((r) => r.status === 403 && r.body.error === "MODALITY_NOT_AVAILABLE"), [r1, r2, r3].map((r) => [r.status, r.body.error]));
  const myMem = (await q<{ id: string }>(`SELECT id FROM organization_worker_memberships WHERE organization_id=$1`, [I])).rows[0].id;
  const closed = [
    ["GET", `/organizations/${I}/credentials/review-queue`], ["GET", `/organizations/${I}/smartmatch/opportunities`], ["GET", `/organizations/${I}/workforce/forecast`],
    ["GET", `/organizations/${I}/coverage/recommendations`], ["GET", `/organizations/${I}/operations/center`], ["GET", `/organizations/${I}/pay-periods`],
    ["GET", `/organizations/${I}/financial-rates`], ["GET", `/organizations/${I}/establishments`], ["GET", `/organizations/${I}/my-admin-establishments`],
    ["PATCH", `/organizations/${I}/workers/${myMem}`], ["GET", `/organizations/${I}/care-quality/agent/briefing`], ["GET", `/organizations/${I}/me/coverage-offers`],
  ] as const;
  const closedRes = await Promise.all(closed.map(([m, p]) => call(m, p, tI, m === "GET" ? undefined : {})));
  check("I14. Backend: revisión de credenciales, SmartMatch, planificación, cobertura, centro operacional, horas, tarifas, agentes y establecimientos cerrados",
    closedRes.every((r) => r.status === 403 && r.body.error === "MODALITY_NOT_AVAILABLE"), closedRes.map((r, i) => `${closed[i][1].split("/").slice(3).join("/")}:${r.status}`));
  const open = await Promise.all([call("GET", `/organizations/${I}/workers`, tI), call("GET", `/organizations/${I}/care-recipients`, tI)]);
  const rec = await call("POST", `/organizations/${I}/care-recipients`, tI, { firstName: "Persona", lastName: "Ficticia" });
  const recId = (rec.body.careRecipient ?? rec.body.recipient ?? rec.body)?.id as string;
  const fam = await call("POST", `/organizations/${I}/access-invitations`, tI, { type: "family", email: `i160-familia-${tag}@example.invalid`, careRecipientId: recId, relationshipType: "hija" });
  check("I15. Lo propio sigue abierto: ver su ficha, crear y ver clientes, invitar a la familia",
    open.every((r) => r.status === 200) && rec.status === 201 && fam.status === 201, [open.map((r) => r.status), rec.status, fam.status, fam.body.error]);
  const outsider = await call("GET", `/organizations/${I}/team`, tA);
  check("I16. Quien no es miembro recibe el 403 de siempre y no se revela la modalidad", outsider.status === 403 && outsider.body.error !== "MODALITY_NOT_AVAILABLE", outsider);

  const sup = (await q<{ id: string }>(`SELECT om.id FROM organization_memberships om WHERE om.user_id=$1 AND om.organization_id=$2`, [ind.id, I])).rows[0].id;
  const db1 = await suErr(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='SUPERVISOR'`, [sup, I]);
  const other = await user("otra-persona"); const otherMem = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [other.id, I])).rows[0].id;
  const db2 = await suErr(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='ORGANIZATION_ADMIN'`, [otherMem, I]);
  const db3 = await suErr(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='WORKER'`, [otherMem, I]);
  const ph = (await q<{ id: string }>(`INSERT INTO workers (user_id) VALUES (NULL) RETURNING id`)).rows[0].id;
  const db4 = await suErr(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA')`, [ph, I]);
  const db5 = await suErr(`UPDATE organization_worker_memberships SET worker_id=$1 WHERE organization_id=$2`, [ph, I]);
  const db6 = await suErr(`INSERT INTO access_invitations (organization_id,invited_by_user_id,invitation_type,email,worker_membership_id,token_hash,expires_at) VALUES ($1,$2,'worker','x@example.invalid',$3,$4,now()+interval '1 day')`, [I, ind.id, myMem, randomBytes(32).toString("hex")]);
  const db7 = await suErr(`INSERT INTO access_invitations (organization_id,invited_by_user_id,invitation_type,staff_role,email,token_hash,expires_at) VALUES ($1,$2,'organization_admin','SUPERVISOR','y@example.invalid',$3,now()+interval '1 day')`, [I, ind.id, randomBytes(32).toString("hex")]);
  const famMem = (await q<{ id: string }>(`SELECT om.id FROM organization_memberships om WHERE om.user_id=$1 AND om.organization_id=$2`, [ind.id, I])).rows[0].id;
  const db8 = await suErr(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='FAMILY'`, [famMem, I]);
  check("I17. Base de datos (aunque se salte el backend): sin supervisoras, sin segunda administradora, WORKER solo para la titular, sin fichas provisionales ni cambio de ficha, sin invitaciones de cuidador ni de supervisora, y la titular no es a la vez familiar",
    [db1, db2, db3, db4, db5, db6, db7, db8].every((e) => e.includes("INDEPENDENT_SINGLE_OPERATOR")), [db1, db2, db3, db4, db5, db6, db7, db8]);
  check("I18. Sigue habiendo exactamente una ficha de cuidadora y una administradora en el independiente",
    (await q(`SELECT 1 FROM organization_worker_memberships WHERE organization_id=$1`, [I])).rowCount === 1
    && (await q(`SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.organization_id=$1 AND r.code='ORGANIZATION_ADMIN'`, [I])).rowCount === 1);

  // ---- Tipo inmutable y su procedimiento ------------------------------------------------------------------
  // Como la aplicación en contexto de Central (mismos ajustes que withPlatformContext), para que RLS deje ver la fila.
  const asCentral = (stmt: string) => rtErr(`BEGIN; SELECT set_config('app.current_user_id','${central.id}',true); SELECT set_config('app.is_superadmin','true',true); ${stmt}; COMMIT;`).finally(() => rt.query("ROLLBACK").catch(() => undefined));
  const vis = await rt.query(`BEGIN; SELECT set_config('app.current_user_id','${central.id}',true); SELECT set_config('app.is_superadmin','true',true); UPDATE organizations SET updated_at=now() WHERE id='${I}'; ROLLBACK;`).then(() => "OK", (e) => (e as Error).message);
  const t1 = await asCentral(`UPDATE organizations SET organization_type='HOME_CARE_AGENCY' WHERE id='${I}'`);
  const t2 = await suErr(`UPDATE organizations SET organization_type='RESIDENTIAL_CARE_HOME' WHERE id=$1`, [A]);
  const t3 = await asCentral(`SELECT set_config('etnara.organization_type_change','ops-procedure',true); UPDATE organizations SET organization_type='RESIDENTIAL_CARE_HOME' WHERE id='${A}'`);
  const typesNow = await q<{ a: string; i: string }>(`SELECT (SELECT organization_type::text FROM organizations WHERE id=$1) a, (SELECT organization_type::text FROM organizations WHERE id=$2) i`, [A, I]);
  check("I19. El tipo de organización no se cambia por ninguna vía directa (app_runtime, superusuario, ni la aplicación fingiendo el procedimiento)",
    vis === "OK" && t1.includes("ORGANIZATION_TYPE_IMMUTABLE") && t2.includes("ORGANIZATION_TYPE_IMMUTABLE") && t3.includes("ORGANIZATION_TYPE_IMMUTABLE")
    && typesNow.rows[0].a === "HOME_CARE_AGENCY" && typesNow.rows[0].i === "INDEPENDENT_PROVIDER", [vis, t1, t2, t3, typesNow.rows]);
  const p1 = await rtErr(`SELECT app_ops_change_organization_type($1,'RESIDENTIAL_CARE_HOME','motivo suficiente','central')`, [A]);
  const p2 = await suErr(`SELECT app_ops_change_organization_type($1,'HOME_CARE_AGENCY','motivo suficiente','central')`, [I]);
  const p3 = await suErr(`SELECT app_ops_change_organization_type($1,'INDEPENDENT_PROVIDER','motivo suficiente','central')`, [A]);
  const p4 = await suErr(`SELECT app_ops_change_organization_type($1,'RESIDENTIAL_CARE_HOME','corto','central')`, [cA.body.organization.id]);
  const p5 = await suErr(`SELECT app_ops_change_organization_type($1,'RESIDENTIAL_CARE_HOME','Corrección ficticia: agencia creada como hogar por error','pruebas-160')`, [cA.body.organization.id]);
  const p5row = await q<{ t: string }>(`SELECT organization_type::text t FROM organizations WHERE id=$1`, [cA.body.organization.id]);
  const p5aud = await q(`SELECT 1 FROM audit_log WHERE action='ORGANIZATION_TYPE_CHANGED_BY_PROCEDURE' AND entity_id=$1`, [cA.body.organization.id]);
  check("I20. Procedimiento específico: solo el propietario de las migraciones; nunca hacia ni desde independiente; con motivo; auditado",
    p1.includes("permission denied") && p2.includes("ORGANIZATION_TYPE_CHANGE_NOT_ALLOWED") && p3.includes("ORGANIZATION_TYPE_CHANGE_NOT_ALLOWED")
    && p4.includes("REASON_REQUIRED") && p5 === "OK" && p5row.rows[0].t === "RESIDENTIAL_CARE_HOME" && p5aud.rowCount === 1, [p1, p2, p3, p4, p5]);
  check("I21. app_runtime no puede ejecutar la provisión interna", (await rtErr(`SELECT app_independent_provision_operator($1,$2,$3,$4)`, [ind.id, I, sup, randomUUID()])).includes("permission denied"));

  // ---- NO REGRESIÓN: agencias y hogares --------------------------------------------------------------------
  const nA = await call("POST", `/platform/organizations/${A}/admin-invitations`, tC, { email: `i160-admin2-agencia-${tag}@example.invalid` });
  const nAact = await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(`i160-admin2-agencia-${tag}@example.invalid`), password });
  const admin2 = { id: (await q<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [`i160-admin2-agencia-${tag}@example.invalid`])).rows[0]?.id ?? "" };
  check("N2. Agencia: segunda administradora invitada y activada como antes, SOLO con ORGANIZATION_ADMIN y sin perfil de cuidadora",
    nA.status === 201 && nAact.status === 201 && (await rolesOf(admin2, A)) === "ORGANIZATION_ADMIN" && (await q(`SELECT 1 FROM workers WHERE user_id=$1`, [admin2.id])).rowCount === 0, [nA.status, nAact.status]);
  const nH = await call("POST", `/platform/organizations/${H}/admin-invitations`, tC, { email: `i160-admin2-hogar-${tag}@example.invalid` });
  const nHact = await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(`i160-admin2-hogar-${tag}@example.invalid`), password });
  const admin2H = { id: (await q<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [`i160-admin2-hogar-${tag}@example.invalid`])).rows[0]?.id ?? "" };
  check("N3. Hogar: segunda administradora igual que antes (sin WORKER ni perfil)", nH.status === 201 && nHact.status === 201 && (await rolesOf(admin2H, H)) === "ORGANIZATION_ADMIN" && (await q(`SELECT 1 FROM workers WHERE user_id=$1`, [admin2H.id])).rowCount === 0);
  const sA = await call("POST", `/organizations/${A}/team/invitations`, tA, { email: `i160-sup-agencia-${tag}@example.invalid`, role: "SUPERVISOR" });
  const tm = await call("GET", `/organizations/${A}/team`, tA);
  const wA = await call("POST", `/organizations/${A}/workers`, tA, { displayName: "Ficha Provisional", internalRole: "CNA" });
  const wB = await call("POST", `/organizations/${A}/workers`, tA, { displayName: "Otra Ficha", internalRole: "HHA" });
  const iw = await call("POST", `/organizations/${A}/access-invitations`, tA, { type: "worker", email: `i160-cuid-agencia-${tag}@example.invalid`, workerMembershipId: wA.body.membership?.id });
  check("N4. Agencia: equipo, supervisoras, varias fichas provisionales e invitaciones de cuidadora funcionan igual",
    sA.status === 201 && tm.status === 200 && wA.status === 201 && wB.status === 201 && iw.status === 201, [sA.status, tm.status, wA.status, wB.status, iw.status]);
  const agencyRoutes = await Promise.all(closed.slice(0, 9).map(([m, p]) => call(m, p.replace(I, A), tA)));
  check("N5. Agencia: ninguna ruta de equipo responde MODALITY_NOT_AVAILABLE (el control no la toca)", agencyRoutes.every((r) => r.body.error !== "MODALITY_NOT_AVAILABLE"), agencyRoutes.map((r) => r.status));
  const hogarRoutes = await Promise.all([call("GET", `/organizations/${H}/establishments`, tH), call("GET", `/organizations/${H}/team`, tH)]);
  check("N6. Hogar: establecimientos y equipo siguen disponibles", hogarRoutes.every((r) => r.status === 200), hogarRoutes.map((r) => r.status));
  const multi = await user("varios-roles"); const mm = await member(multi, A, ["ORGANIZATION_ADMIN", "SUPERVISOR"]);
  const fx = await suErr(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='FAMILY'`, [mm, A]);
  check("N7. Agencia: las combinaciones de roles que ya se permitían siguen permitidas (los guardas nuevos no aplican)", fx === "OK" && (await rolesOf(multi, A)) === "FAMILY,ORGANIZATION_ADMIN,SUPERVISOR", fx);
  const life = await call("PATCH", `/platform/organizations/${cH.body.organization.id}/lifecycle`, tC, { action: "suspend", reason: "Prueba ficticia de ciclo de vida" });
  check("N8. Ciclo de vida desde Central (suspender) sigue funcionando: el guarda de tipo no interfiere", life.status === 200 && life.body.organization?.status === "suspended", life);

  // ---- PR B «Mi práctica»: una sola persona administra y presta el servicio --------------------------------
  const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const sh1 = await call("POST", `/organizations/${I}/shifts`, tI, { careRecipientId: recId, scheduledStart: iso(-10), scheduledEnd: iso(120), requiredRole: "INDEPENDENT_CAREGIVER" });
  const shiftId = (sh1.body.shift ?? sh1.body)?.id as string;
  // 161 (PR C): sin política PROPIA no hay requisitos que evaluar (ni del catálogo de la plataforma): se asigna.
  const self = await call("POST", `/organizations/${I}/me/shifts/${shiftId}/self-assign`, tI, {});
  const myCompliance = await call("GET", `/organizations/${I}/workers/${myMem}/compliance`, tI);
  check("B1. Crea su turno; sin requisitos propios configurados se autoasigna (161) y su resumen es legible",
    sh1.status === 201 && self.status === 201 && myCompliance.status === 200 && myCompliance.body.eligibility === "eligible", [sh1.status, self.status, self.body.error, myCompliance.body]);
  // Fixture SOLO de prueba para la práctica de Ana (abajo): política propia sin requisitos obligatorios.
  const fixtureSet = async (o: string) => (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id, worker_role, name) VALUES ($1,'INDEPENDENT_CAREGIVER','Fixture de prueba 160B') RETURNING id`, [o])).rows[0].id;
  const again = await call("POST", `/organizations/${I}/me/shifts/${shiftId}/self-assign`, tI, {});
  const mine = await call("GET", `/organizations/${I}/me/shifts`, tI);
  const selfAudit = await q(`SELECT 1 FROM audit_log WHERE action='SHIFT_SELF_ASSIGNED' AND organization_id=$1`, [I]);
  check("B2. Con la elegibilidad cumplida: «Asignármelo» asigna y acepta en una sola operación (reglas de Turnos), auditado, sin duplicar; aparece en su «Mi día»",
    self.status === 201 && self.body.assignment?.response_status === "accepted" && again.status === 409 && selfAudit.rowCount === 1 && (mine.body.shifts ?? []).some((x: Json) => x.id === shiftId),
    [self.status, self.body.error, again.status, again.body.error, selfAudit.rowCount]);
  const checkIn = await call("POST", `/organizations/${I}/shifts/${shiftId}/check-in`, tI, { verificationMethodCode: "CAREGIVER_SESSION" });
  const meal = await call("POST", `/organizations/${I}/shifts/${shiftId}/care-events`, tI, { typeCode: "MEAL", careRecipientId: recId, payload: { mealType: "Almuerzo", amountConsumed: "Mitad" } });
  const timeline = await call("GET", `/organizations/${I}/care-recipients/${recId}/care-events`, tI);
  check("B3. Registra actividades: inicia la visita y documenta un registro de cuidado de su cliente",
    [200, 201].includes(checkIn.status) && meal.status === 201 && timeline.status === 200, [checkIn.status, checkIn.body.error, meal.status, meal.body.error, timeline.status]);
  const convs = await call("GET", `/organizations/${I}/conversations`, tI);
  const extraClosed = await Promise.all([
    call("GET", `/organizations/${I}/compliance/audit`, tI), call("POST", `/organizations/${I}/compliance/agent/briefing`, tI, {}), call("POST", `/organizations/${I}/my-agency-conversation`, tI, {}),
  ]);
  check("B4. Mensajes con familias disponibles; auditoría y agente de cumplimiento de agencia y «escribir a mi agencia» cerrados (403 MODALITY_NOT_AVAILABLE)",
    convs.status === 200 && extraClosed.every((r) => r.status === 403 && r.body.error === "MODALITY_NOT_AVAILABLE"), [convs.status, extraClosed.map((r) => r.status)]);
  const agencyCompliance = await call("GET", `/organizations/${A}/compliance/audit`, tA);
  const agencyChat = await call("POST", `/organizations/${A}/my-agency-conversation`, await login(ana, A), {});
  check("B5. Agencia: su auditoría de cumplimiento y la conversación de la cuidadora con su agencia siguen igual", agencyCompliance.status === 200 && [200, 201].includes(agencyChat.status), [agencyCompliance.status, agencyChat.status, agencyChat.body.error]);

  // ---- PR B: persona que también trabaja para una agencia (Ana: CNA en la agencia A e independiente en I2) ----
  const tAna2 = await login(ana, I2);
  const anaMemI2 = (await q<{ id: string }>(`SELECT id FROM organization_worker_memberships WHERE organization_id=$1`, [I2])).rows[0].id;
  await fixtureSet(I2);
  const recI2 = (await call("POST", `/organizations/${I2}/care-recipients`, tAna2, { firstName: "Cliente", lastName: "Ficticio" })).body;
  const recI2Id = (recI2.careRecipient ?? recI2.recipient ?? recI2)?.id as string;
  // Agencia A: política con revisión de la agencia para su credencial.
  const setA = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id, worker_role, name) VALUES ($1,'CNA','Política ficticia agencia A') RETURNING id`, [A])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id, credential_type_id, is_mandatory, requires_organization_review) VALUES ($1,$2,true,true)`, [setA, credType]);
  const recA = (await call("POST", `/organizations/${A}/care-recipients`, tA, { firstName: "Persona", lastName: "Agencia" })).body;
  const recAId = (recA.careRecipient ?? recA.recipient ?? recA)?.id as string;
  const shA = (await call("POST", `/organizations/${A}/shifts`, tA, { careRecipientId: recAId, scheduledStart: iso(24 * 60), scheduledEnd: iso(24 * 60 + 240), requiredRole: "CNA" })).body;
  const shAId = (shA.shift ?? shA)?.id as string;
  const aBlocked = await call("POST", `/organizations/${A}/shifts/${shAId}/assignments`, tA, { organizationWorkerMembershipId: anaMemA });
  const anaCred = (await q<{ id: string }>(`SELECT id FROM credentials WHERE worker_id=$1`, [anaWorker])).rows[0].id;
  const anaSelfReview = await call("POST", `/organizations/${I2}/workers/${anaMemI2}/credentials/${anaCred}/review`, tAna2, { reviewStatus: "approved" });
  // Aprobar por la ruta exige un documento adjunto (regla vigente): en esta prueba la aprobación de la administradora
  // de la agencia se registra directamente, igual que la escribiría el servicio.
  const review = await suErr(`INSERT INTO organization_credential_reviews (credential_id, organization_id, reviewed_by_user_id, review_status, reviewed_at) VALUES ($1,$2,$3,'approved',now())`, [anaCred, A, adminA.id]).then((r) => ({ status: r === "OK" ? 200 : 500, body: { error: r } }));
  const aOk = await call("POST", `/organizations/${A}/shifts/${shAId}/assignments`, tA, { organizationWorkerMembershipId: anaMemA });
  check("B6. Agencia intacta: sin la revisión de la agencia Ana NO es elegible allí; su práctica independiente no puede revisarse a sí misma; tras la revisión de la agencia, sí",
    aBlocked.status === 409 && String(aBlocked.body.error ?? "").startsWith("WORKER_NOT_ELIGIBLE") && anaSelfReview.status === 403 && review.status === 200 && aOk.status === 201,
    [aBlocked.status, aBlocked.body.error, anaSelfReview.status, anaSelfReview.body.error, review.status, review.body.error, aOk.status, aOk.body.error]);
  const anaAcceptA = await call("POST", `/organizations/${A}/me/shifts/${shAId}/respond`, await login(ana, A), { decision: "accepted" });
  const shI2a = (await call("POST", `/organizations/${I2}/shifts`, tAna2, { careRecipientId: recI2Id, scheduledStart: iso(24 * 60 + 60), scheduledEnd: iso(24 * 60 + 180) })).body;
  const shI2aId = (shI2a.shift ?? shI2a)?.id as string;
  const overlap = await call("POST", `/organizations/${I2}/me/shifts/${shI2aId}/self-assign`, tAna2, {});
  const overlapLeft = await q(`SELECT 1 FROM assignments WHERE shift_id=$1`, [shI2aId]);
  const overlapShift = await q<{ status: string }>(`SELECT status::text FROM shifts WHERE id=$1`, [shI2aId]);
  const shI2b = (await call("POST", `/organizations/${I2}/shifts`, tAna2, { careRecipientId: recI2Id, scheduledStart: iso(48 * 60), scheduledEnd: iso(48 * 60 + 120) })).body;
  const shI2bId = (shI2b.shift ?? shI2b)?.id as string;
  const free = await call("POST", `/organizations/${I2}/me/shifts/${shI2bId}/self-assign`, tAna2, {});
  check("B7. Su agenda es una sola: no puede asignarse en su práctica un turno que choca con el aceptado en la agencia (nada queda a medias); uno libre, sí",
    anaAcceptA.status === 200 && overlap.status === 409 && overlap.body.error === "MY_SCHEDULE_CONFLICT" && overlapLeft.rowCount === 0 && overlapShift.rows[0].status === "unassigned" && free.status === 201,
    [anaAcceptA.status, overlap.status, overlap.body.error, overlapLeft.rowCount, overlapShift.rows[0]?.status, free.status, free.body.error]);
  const agencySelf = await call("POST", `/organizations/${A}/me/shifts/${shAId}/self-assign`, tA, {});
  const hogarSelf = await call("POST", `/organizations/${H}/me/shifts/${randomUUID()}/self-assign`, tH, {});
  check("B10. «Asignármelo» no existe en agencias ni hogares (403 SELF_ASSIGN_INDEPENDENT_ONLY): su flujo de asignar → aceptar no cambia",
    agencySelf.status === 403 && agencySelf.body.error === "SELF_ASSIGN_INDEPENDENT_ONLY" && hogarSelf.status === 403 && hogarSelf.body.error === "SELF_ASSIGN_INDEPENDENT_ONLY", [agencySelf, hogarSelf]);
  const crossA = await call("GET", `/organizations/${I2}/care-recipients`, tA);
  const agencyList = await call("GET", `/organizations/${A}/care-recipients`, tA);
  const i2List = await call("GET", `/organizations/${I2}/care-recipients`, tAna2);
  const i2Shifts = await call("GET", `/organizations/${I2}/shifts`, tAna2);
  check("B8. Aislamiento: la agencia no entra a la práctica de Ana ni ve sus clientes; la práctica no lista clientes ni turnos de la agencia",
    crossA.status === 403 && !JSON.stringify(agencyList.body).includes(recI2Id) && i2List.status === 200 && !JSON.stringify(i2List.body).includes(recAId)
    && !JSON.stringify(i2Shifts.body).includes(shAId) && JSON.stringify(i2Shifts.body).includes(shI2bId),
    [crossA.status, agencyList.status, i2List.status, i2Shifts.status]);
  check("B9. La agencia sigue sin ver la ficha de su práctica independiente y su ficha de agencia no cambió",
    (await q(`SELECT 1 FROM organization_worker_memberships WHERE id=$1 AND organization_id=$2 AND status='active' AND internal_role='CNA'`, [anaMemA, A])).rowCount === 1
    && !(await call("GET", `/organizations/${A}/workers`, tA)).body.workers?.some?.((w: Json) => w.id === anaMemI2));

  // ---- Apagar de nuevo: lo creado sigue, no se crean más ----------------------------------------------------
  await q(`UPDATE platform_modalities SET enabled=false WHERE code='INDEPENDENT_PROVIDER'`);
  const c3 = await call("POST", "/platform/organizations", tC, { name: `Otra Independiente ${tag}`, organizationType: "INDEPENDENT_PROVIDER" });
  const still = await call("GET", `/organizations/${I}/care-recipients`, tI);
  check("I22. Con la modalidad apagada de nuevo: no se crean más independientes y los existentes siguen operando", c3.status === 409 && still.status === 200, [c3.status, still.status]);
  check("I23. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);

  server.close(); await pool.end(); await rt.end(); await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 900)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
