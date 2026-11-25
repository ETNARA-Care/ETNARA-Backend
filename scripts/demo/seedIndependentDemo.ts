/**
 * SOLO DEMO (rama demo/independientes-25nov, nunca se fusiona con main).
 * Carga datos ficticios en el proyecto de demostración separado y comprueba el funcionamiento por la API.
 * Corre junto al servidor (después de que responde /health), usando la misma API que el portal.
 *
 * Protecciones: se niega a correr si DEMO_MODE no es el de la demo, si el enlace de activación no es un
 * dominio *.up.railway.app o si la base tiene alguna organización que no sea «Demo».
 * Idempotente: si «Agencia Demo» ya existe no vuelve a crear nada; solo renueva la autorización temporal
 * de la demo cuando la modalidad está apagada y no hay una vigente, y repite la autocomprobación.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "pg";

const TAG = "[DEMO-CARGA]";
const log = (m: string) => console.log(`${TAG} ${m}`);
const API = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const MAIL = process.env.DEMO_MAIL_FILE || "/tmp/etnara-demo-mail.jsonl";
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} es obligatoria en la demo`); return v; };

const ACCOUNTS = {
  central: { email: (process.env.PLATFORM_ADMIN_EMAIL ?? "").toLowerCase(), pw: () => env("PLATFORM_ADMIN_PASSWORD") },
  agencia: { email: "agencia@demo.invalid", pw: () => env("DEMO_PW_AGENCIA") },
  hogar: { email: "hogar@demo.invalid", pw: () => env("DEMO_PW_HOGAR") },
  lucia: { email: "lucia@demo.invalid", pw: () => env("DEMO_PW_LUCIA") },
  ana: { email: "ana@demo.invalid", pw: () => env("DEMO_PW_ANA") },
  familia: { email: "familia@demo.invalid", pw: () => env("DEMO_PW_FAMILIA") },
};

type R = { s: number; j: any };
async function call(method: string, path: string, token?: string, body?: unknown): Promise<R> {
  const r = await fetch(API + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j: any = {}; try { j = await r.json(); } catch { /* sin cuerpo */ }
  return { s: r.status, j };
}
function must(r: R, ok: number[], what: string): any { if (!ok.includes(r.s)) throw new Error(`${what}: HTTP ${r.s} ${JSON.stringify(r.j).slice(0, 200)}`); return r.j; }
const login = async (a: { email: string; pw: () => string }) => must(await call("POST", "/auth/login", undefined, { email: a.email, password: a.pw() }), [200], `login ${a.email}`).token as string;
function tokenFor(email: string): string {
  if (!existsSync(MAIL)) return "";
  const lines = readFileSync(MAIL, "utf8").trim().split("\n").filter(Boolean).reverse();
  const m = lines.find((l) => l.toLowerCase().includes(email.toLowerCase()));
  return /token=([A-Fa-f0-9]{64})/.exec(m ?? "")?.[1] ?? "";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function guard(db: Client) {
  if (process.env.DEMO_MODE !== "etnara-demo-independientes") throw new Error("DEMO_MODE no es el de la demo: no se carga nada");
  const host = new URL(env("ACTIVATION_BASE_URL")).hostname;
  if (!host.endsWith(".up.railway.app") || host.includes("etnaracare")) throw new Error(`ACTIVATION_BASE_URL (${host}) no es un dominio de demo`);
  const foreign = (await db.query(`SELECT count(*)::int n FROM organizations WHERE name NOT ILIKE '%Demo%'`)).rows[0].n;
  if (foreign > 0) throw new Error(`la base tiene ${foreign} organización(es) que no son de demo: no se carga nada`);
}

async function authorizeIfNeeded(db: Client, minutes: number, reason: string) {
  const st = (await db.query(`SELECT enabled FROM platform_modalities WHERE code='INDEPENDENT_PROVIDER'`)).rows[0];
  const open = (await db.query(`SELECT count(*)::int n FROM platform_modality_activation_authorizations WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`)).rows[0].n;
  if (!st.enabled && open === 0) {
    await db.query(`SELECT * FROM app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','Demo ETNARA (datos ficticios)',$1,$2)`, [reason, minutes]);
    log(`autorización temporal de la demo creada (${minutes} min)`);
  }
}

async function orgAdmin(C: string, name: string, type: string, a: { email: string; pw: () => string }, existing = false) {
  const org = must(await call("POST", "/platform/organizations", C, { name, organizationType: type, status: "active" }), [201], `crear ${name}`).organization;
  must(await call("POST", `/platform/organizations/${org.id}/admin-invitations`, C, { email: a.email }), [201], `invitar ${a.email}`);
  await sleep(600);
  const token = tokenFor(a.email); if (!token) throw new Error(`no se interceptó la invitación de ${a.email}`);
  if (existing) must(await call("POST", "/platform/admin-invitations/accept", await login(a), { token }), [200, 201], `aceptar ${a.email}`);
  else must(await call("POST", "/platform/admin-invitations/activate", undefined, { token, password: a.pw() }), [201], `activar ${a.email}`);
  log(`${name} creada; administración ${a.email} activa`);
  return org.id as string;
}

async function seed(db: Client) {
  const C = await login(ACCOUNTS.central);
  // Agencia Demo, con su cuidadora Ana Demo y un cliente.
  const A = await orgAdmin(C, "Agencia Demo", "HOME_CARE_AGENCY", ACCOUNTS.agencia);
  const tA = await login(ACCOUNTS.agencia);
  must(await call("POST", `/organizations/${A}/care-recipients`, tA, { firstName: "Pedro", lastName: "Demo" }), [201], "cliente de la agencia");
  const mem = must(await call("POST", `/organizations/${A}/workers`, tA, { displayName: "Ana Demo", internalRole: "CNA" }), [201], "cuidadora de la agencia").membership;
  const inv = must(await call("POST", `/organizations/${A}/access-invitations`, tA, { type: "worker", email: ACCOUNTS.ana.email, workerMembershipId: mem.id }), [201], "invitar a Ana");
  must(await call("POST", "/access-invitations/activate", undefined, { token: inv.token, password: ACCOUNTS.ana.pw() }), [200, 201], "activar Ana");
  log("Ana Demo activa como cuidadora de Agencia Demo");
  // Hogar Demo con un establecimiento y una residente.
  const H = await orgAdmin(C, "Hogar Demo", "RESIDENTIAL_CARE_HOME", ACCOUNTS.hogar);
  const tH = await login(ACCOUNTS.hogar);
  const est = must(await call("POST", `/organizations/${H}/establishments`, tH, { name: "Residencia Demo Las Palmas", address: "Dirección ficticia, Puerto Rico" }), [201], "establecimiento").establishment;
  const rosa = must(await call("POST", `/organizations/${H}/care-recipients`, tH, { firstName: "Rosa", lastName: "Demo" }), [201], "residente");
  const rosaId = (rosa.careRecipient ?? rosa.recipient ?? rosa).id;
  must(await call("POST", `/organizations/${H}/establishments/${est.id}/residents`, tH, { recipientId: rosaId }), [201], "asignar residente");
  log("Hogar Demo con su establecimiento y residente");
  // Encender SOLO para la carga (tres llaves: autorización de ops, variable de la demo y acción en Central con motivo).
  await authorizeIfNeeded(db, 15, "Carga inicial de la demo con datos ficticios");
  must(await call("PATCH", "/platform/modalities/INDEPENDENT_PROVIDER", C, { enabled: true, reason: "Carga inicial de la demo con datos ficticios" }), [200], "encender para la carga");
  const L = await orgAdmin(C, "Práctica Lucía Demo", "INDEPENDENT_PROVIDER", ACCOUNTS.lucia);
  must(await call("PUT", `/platform/organizations/${L}/features/SHIFT_REPORTS`, C, { enabled: true, reason: "Demo: informe del proveedor" }), [200], "informe de turno");
  const tL = await login(ACCOUNTS.lucia);
  const carmen = must(await call("POST", `/organizations/${L}/care-recipients`, tL, { firstName: "Carmen", lastName: "Demo" }), [201], "cliente de Lucía");
  const carmenId = (carmen.careRecipient ?? carmen.recipient ?? carmen).id;
  const fam = must(await call("POST", `/organizations/${L}/access-invitations`, tL, { type: "family", email: ACCOUNTS.familia.email, careRecipientId: carmenId, relationshipType: "hija" }), [201], "invitar familia");
  must(await call("POST", "/access-invitations/activate", undefined, { token: fam.token, password: ACCOUNTS.familia.pw() }), [200, 201], "activar familia");
  log("Práctica Lucía Demo con su cliente Carmen Demo y la familia activa");
  // Ana también tiene su práctica y registra un documento autodeclarado (la agencia NO lo hereda como revisado).
  const N = await orgAdmin(C, "Práctica Ana Demo", "INDEPENDENT_PROVIDER", ACCOUNTS.ana, true);
  const tAna = await login(ACCOUNTS.ana);
  must(await call("POST", "/me/active-organization", tAna, { organizationId: N }), [200], "Ana en su práctica");
  must(await call("POST", `/organizations/${N}/practice/documents`, tAna, { credentialTypeCode: "CPR", issuingEntityName: "Entidad ficticia", expiresAt: day(200) }), [201], "documento de Ana");
  log("Práctica Ana Demo con un documento autodeclarado (CPR)");
  must(await call("PATCH", "/platform/modalities/INDEPENDENT_PROVIDER", C, { enabled: false, reason: "Fin de la carga inicial: queda apagada para encenderla en persona" }), [200], "apagar tras la carga");
  log("modalidad apagada al terminar la carga");
}

async function selfCheck(db: Client) {
  const out: Array<[string, boolean, unknown?]> = [];
  const ck = (id: string, ok: boolean, d?: unknown) => { out.push([id, ok, d]); console.log(`[DEMO-AUTOCHECK] ${ok ? "PASS" : "FAIL"} ${id}${ok ? "" : " " + JSON.stringify(d).slice(0, 300)}`); };
  const ids = Object.fromEntries((await db.query(`SELECT name, id FROM organizations`)).rows.map((r) => [r.name, r.id]));
  const [C, tA, tH, tL, tAna, tF] = [await login(ACCOUNTS.central), await login(ACCOUNTS.agencia), await login(ACCOUNTS.hogar), await login(ACCOUNTS.lucia), await login(ACCOUNTS.ana), await login(ACCOUNTS.familia)];
  ck("K0 las seis cuentas de demo entran", !!(C && tA && tH && tL && tAna && tF));
  const m = (await call("GET", "/platform/modalities", C)).j.modalities?.[0];
  ck("K1 Central: modalidad apagada; servidor de la demo autorizado; autorización temporal de la demo vigente", m && m.enabled === false && m.activationAllowed === true && m.databaseUnlocked === true, m);
  const k2 = [(await call("GET", "/platform/modalities", tA)).s, (await call("GET", "/platform/modalities", tH)).s, (await call("GET", "/platform/modalities", tL)).s, (await call("GET", "/platform/modalities", tF)).s];
  ck("K2 el interruptor es solo de Central (agencia, hogar, práctica y familia → 403)", k2.every((s) => s === 403), k2);
  const A = ids["Agencia Demo"], H = ids["Hogar Demo"], L = ids["Práctica Lucía Demo"], N = ids["Práctica Ana Demo"];
  const iso = { practicaEnAgencia: (await call("GET", `/organizations/${A}/care-recipients`, tL)).s, agenciaEnPractica: (await call("GET", `/organizations/${L}/care-recipients`, tA)).s, hogarEnPractica: (await call("GET", `/organizations/${L}/care-recipients`, tH)).s, familiaEnAgencia: (await call("GET", `/organizations/${A}/care-recipients`, tF)).s, practicaEnHogar: (await call("GET", `/organizations/${H}/establishments`, tL)).s };
  ck("K3 aislamiento entre organizaciones (403/404)", Object.values(iso).every((s) => s === 403 || s === 404), iso);
  const ok = { agencia: (await call("GET", `/organizations/${A}/care-recipients`, tA)).s, hogar: (await call("GET", `/organizations/${H}/establishments`, tH)).s, practica: (await call("GET", `/organizations/${L}/care-recipients`, tL)).s, docsAna: (await call("GET", `/organizations/${N}/practice/documents`, tAna)).s, familia: (await call("GET", "/me", tF)).s };
  ck("K4 cada cuenta ve lo suyo (200)", Object.values(ok).every((s) => s === 200), ok);
  const cred = (await db.query(`SELECT c.declared_by_holder, c.status::text FROM credentials c JOIN workers w ON w.id=c.worker_id JOIN users u ON u.id=w.user_id WHERE u.email=$1`, [ACCOUNTS.ana.email])).rows;
  ck("K5 el documento de Ana es autodeclarado (la agencia lo revisa aparte)", cred.length >= 1 && cred.every((c) => c.declared_by_holder === true), cred);
  const mails = existsSync(MAIL) ? readFileSync(MAIL, "utf8").trim().split("\n").filter(Boolean).length : 0;
  ck("K6 correos interceptados (ninguno enviado)", mails >= 4 && (process.env.RESEND_API_KEY ?? "").startsWith("demo-"), { mails });
  const failed = out.filter((x) => !x[1]).length;
  console.log(`[DEMO-AUTOCHECK] RESULTADO ${out.length - failed}/${out.length}`);
}

async function main() {
  for (let i = 0; i < 180; i++) { try { if ((await fetch(API + "/health")).ok) break; } catch { /* aún arrancando */ } await sleep(1000); }
  const db = new Client({ connectionString: env("MIGRATIONS_DATABASE_URL") }); await db.connect();
  try {
    await guard(db);
    const exists = (await db.query(`SELECT 1 FROM organizations WHERE name='Agencia Demo'`)).rowCount;
    if (!exists) { log("base vacía: cargando datos ficticios"); await seed(db); } else log("datos ficticios ya cargados: no se repite la carga");
    await authorizeIfNeeded(db, 1440, "Demo: encendido personal en ETNARA Central (datos ficticios)");
    await selfCheck(db);
  } catch (e) {
    console.error(`${TAG} DETENIDO: ${(e as Error).message}`);
  } finally { await db.end(); }
}
void main();
