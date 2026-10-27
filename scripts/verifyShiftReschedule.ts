/**
 * Shift reschedule: permissions, audit and caregiver notice (migration 133, auditoría B4).
 *
 *   - administradora and supervisora may change the times (PATCH /shifts/:id) -> 200;
 *     caregivers (assigned or not), family, another agency and ETNARA Central may not;
 *   - each real change writes ONE audit_log row SHIFT_RESCHEDULED (actor, previous and new
 *     times only) and one in-app SHIFT_RESCHEDULED notice to every caregiver whose
 *     assignment is pending or accepted with an active membership;
 *   - rejected caregivers, inactive memberships, family and other agencies get no notice;
 *   - no audit and no notice when nothing moves (status-only update, same times) or when
 *     the request is refused; invalid times 400; a shift whose arrival started stays locked.
 * Runs with AUTHZ_DB_MODE=superuser|app_runtime. Synthetic data, disposable databases only.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
const mode = process.env.AUTHZ_DB_MODE ?? "superuser";
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

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
    let json: any = {}; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json };
  };

  const orgA = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`RESCHED A ${tag}`]))[0].id;
  await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'EN_CAMINO',true) ON CONFLICT DO NOTHING`, [orgA]);
  const orgB = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`RESCHED B ${tag}`]))[0].id;
  type P = { userId: string; token: string; owm?: string };
  async function person(key: string, org: string, role: string | null, worker = false): Promise<P> {
    const email = `resched-${key}-${tag}@example.invalid`;
    const userId = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash]))[0].id;
    if (role) {
      const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, org]))[0].id;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, org, role]);
    } else await q(`INSERT INTO platform_admins (user_id,granted_by_user_id) VALUES ($1,$1)`, [userId]);
    let owm: string | undefined;
    if (worker) {
      const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, key]))[0].id;
      owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, org]))[0].id;
    }
    const login = await call("POST", "/auth/login", "", { email, password });
    if (login.status !== 200) throw new Error(`login ${key} ${login.status}`);
    return { userId, token: login.json.token, owm };
  }
  const admin = await person("admin", orgA, "ORGANIZATION_ADMIN");
  const sup = await person("sup", orgA, "SUPERVISOR");
  const cgAccepted = await person("cg-accepted", orgA, "WORKER", true);
  const cgPending = await person("cg-pending", orgA, "WORKER", true);
  const cgRejected = await person("cg-rejected", orgA, "WORKER", true);
  const cgInactive = await person("cg-inactive", orgA, "WORKER", true);
  const cgOther = await person("cg-other", orgA, "WORKER", true);
  const fam = await person("fam", orgA, "FAMILY");
  const adminB = await person("admin-b", orgB, "ORGANIZATION_ADMIN");
  const central = await person("central", orgA, null);

  const r1 = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [orgA, `R-${tag}`]))[0].id;
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [fam.userId, orgA, r1]);
  const shift = (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+interval '3 days',now()+interval '3 days 4 hours','confirmed') RETURNING id`, [orgA, r1]))[0].id;
  for (const [p, r] of [[cgAccepted, "accepted"], [cgPending, "pending"], [cgRejected, "rejected"], [cgInactive, "accepted"]] as const) {
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status) VALUES ($1,$2,$3,$4,$5)`, [orgA, shift, p.owm, r1, r]);
  }
  await q(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [cgInactive.owm]);

  const P = `/organizations/${orgA}/shifts/${shift}`;
  const at = (days: number, hour: number) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
  const audits = async () => (await q(`SELECT actor_user_id, previous_value, new_value FROM audit_log WHERE entity_id=$1 AND action='SHIFT_RESCHEDULED' ORDER BY occurred_at`, [shift]));
  const notices = async (u: string) => Number((await q(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND related_entity_id=$2 AND notification_type='SHIFT_RESCHEDULED'`, [u, shift]))[0].n);

  // refused attempts first: nothing must be written
  for (const [who, p, ok] of [["cuidadora asignada", cgAccepted, [403]], ["otra cuidadora", cgOther, [403]], ["familia", fam, [403]],
    ["Central", central, [403]], ["otra agencia (URL ajena)", adminB, [403]]] as const) {
    const r = await call("PATCH", P, p.token, { scheduledStart: at(4, 13), scheduledEnd: at(4, 17) });
    check(`${who} no puede cambiar el horario`, (ok as readonly number[]).includes(r.status), `${r.status}`);
  }
  check("otra agencia (su URL, id ajeno) no puede", (await call("PATCH", `/organizations/${orgB}/shifts/${shift}`, adminB.token, { scheduledStart: at(4, 13), scheduledEnd: at(4, 17) })).status === 404);
  check("intentos rechazados: sin auditoría", (await audits()).length === 0);
  check("intentos rechazados: sin avisos", (await notices(cgAccepted.userId)) === 0);
  check("fin antes del inicio: 400", (await call("PATCH", P, admin.token, { scheduledStart: at(4, 18), scheduledEnd: at(4, 17) })).status === 400);

  // administradora
  const r1a = await call("PATCH", P, admin.token, { scheduledStart: at(4, 13), scheduledEnd: at(4, 17) });
  check("administradora cambia el horario: 200", r1a.status === 200, `${r1a.status}`);
  let a = await audits();
  check("administradora: 1 fila de auditoría con su usuario", a.length === 1 && a[0].actor_user_id === admin.userId, `${a.length}`);
  check("auditoría: horario anterior y nuevo, sin otros datos",
    a.length === 1 && Object.keys(a[0].previous_value).sort().join() === "scheduledEnd,scheduledStart"
      && new Date(a[0].new_value.scheduledStart).toISOString() === at(4, 13), JSON.stringify(a[0]?.new_value ?? {}));
  check("aviso a la cuidadora aceptada", (await notices(cgAccepted.userId)) === 1);
  check("aviso a la cuidadora pendiente", (await notices(cgPending.userId)) === 1);
  check("sin aviso a la cuidadora que rechazó", (await notices(cgRejected.userId)) === 0);
  check("sin aviso a la cuidadora con membresía inactiva", (await notices(cgInactive.userId)) === 0);
  check("sin aviso a otra cuidadora", (await notices(cgOther.userId)) === 0);
  check("sin aviso a la familia", (await notices(fam.userId)) === 0);
  check("sin aviso a la administradora que hizo el cambio", (await notices(admin.userId)) === 0);
  const mine = await call("GET", `/organizations/${orgA}/me/notifications`.replace(`/organizations/${orgA}`, ""), cgAccepted.token);
  check("la cuidadora ve el aviso en su bandeja", mine.status === 200 && JSON.stringify(mine.json).includes("SHIFT_RESCHEDULED"), `${mine.status}`);
  check("el aviso dice «La agencia cambió el horario de uno de tus turnos» y abre el turno",
    JSON.stringify(mine.json).includes("La agencia cambió el horario de uno de tus turnos") && JSON.stringify(mine.json).includes(shift));

  // supervisora
  const r2 = await call("PATCH", P, sup.token, { scheduledEnd: at(4, 18) });
  check("supervisora cambia la hora de fin: 200", r2.status === 200, `${r2.status}`);
  a = await audits();
  check("supervisora: 2ª fila de auditoría con su usuario", a.length === 2 && a[1].actor_user_id === sup.userId, `${a.length}`);
  check("segundo aviso a la cuidadora aceptada", (await notices(cgAccepted.userId)) === 2);

  // nothing moves
  await call("PATCH", P, admin.token, { scheduledStart: at(4, 13), scheduledEnd: at(4, 18) });
  await call("PATCH", P, admin.token, { requiredRole: "Cuidador/a" });
  check("mismo horario o solo otro campo: sin auditoría nueva", (await audits()).length === 2);
  check("mismo horario o solo otro campo: sin aviso nuevo", (await notices(cgAccepted.userId)) === 2);

  // arrival («Llegué») registered -> locked by 107, nothing written
  const method = (await q(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`))[0].id;
  const s2 = (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '10 minutes',now()+interval '3 hours','confirmed') RETURNING id`, [orgA, r1]))[0].id;
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status) VALUES ($1,$2,$3,$4,'accepted')`, [orgA, s2, cgAccepted.owm, r1]);
  const arrival = await call("POST", `/organizations/${orgA}/shifts/${s2}/arrival`, cgAccepted.token, {});
  const locked = await call("PATCH", `/organizations/${orgA}/shifts/${s2}`, admin.token, { scheduledStart: at(5, 13), scheduledEnd: at(5, 17) });
  check("turno con «Llegué» registrado: no se puede mover (409)", arrival.status < 300 && locked.status === 409, `arrival=${arrival.status} patch=${locked.status}`);
  check("turno con «Llegué» registrado: sin auditoría ni aviso",
    Number((await q(`SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND action='SHIFT_RESCHEDULED'`, [s2]))[0].n) === 0);
  // check-in without «Llegué»: today the schedule can still be moved (107 only locks journey/arrival);
  // documented as a decision for Rafa. At least it is now audited and the caregiver is told.
  const s3 = (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '10 minutes',now()+interval '3 hours','in_progress') RETURNING id`, [orgA, r1]))[0].id;
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status) VALUES ($1,$2,$3,$4,'accepted')`, [orgA, s3, cgAccepted.owm, r1]);
  await q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type) VALUES ($1,$2,$3,$4,'check_in')`, [orgA, s3, cgAccepted.owm, method]);
  const moved = await call("PATCH", `/organizations/${orgA}/shifts/${s3}`, admin.token, { scheduledEnd: new Date(Date.now() + 5 * 36e5).toISOString() });
  const movedAudit = Number((await q(`SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND action='SHIFT_RESCHEDULED'`, [s3]))[0].n);
  check("turno ya comenzado sin «Llegué»: el cambio (permitido hoy) queda auditado y avisado",
    moved.status === 200 && movedAudit === 1, `patch=${moved.status} audit=${movedAudit}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\nCAMBIO DE HORARIO — modo ${mode}`);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
  console.log(`\nSHIFT_RESCHEDULE mode=${mode} total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
  server.close(); await pool.end(); await db.end();
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
