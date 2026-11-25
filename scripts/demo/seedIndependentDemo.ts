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
// PDF mínimo y válido, ficticio, para probar el almacenamiento de documentos.
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
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
  // K7: recorrido completo de una práctica en la demo alojada (una sola vez, en la práctica de Ana para no
  // tocar la de Lucía, que es la que usa Rafa): cliente, turno con «Asignármelo», visita con registros,
  // informe del proveedor publicado, archivo adjunto al almacenamiento y lo que ve la familia.
  const done = (await db.query(`SELECT 1 FROM care_recipients WHERE organization_id=$1 AND first_name='Luis'`, [N]).catch(() => ({ rowCount: 0 }))).rowCount;
  if (!done) {
    try {
      must(await call("PUT", `/platform/organizations/${N}/features/SHIFT_REPORTS`, C, { enabled: true, reason: "Demo: informe del proveedor" }), [200], "informe de turno (Ana)");
      must(await call("POST", "/me/active-organization", tAna, { organizationId: N }), [200], "Ana en su práctica");
      const luis = must(await call("POST", `/organizations/${N}/care-recipients`, tAna, { firstName: "Luis", lastName: "Demo" }), [201], "cliente de Ana");
      const luisId = (luis.careRecipient ?? luis.recipient ?? luis).id;
      const shift = must(await call("POST", `/organizations/${N}/shifts`, tAna, { careRecipientId: luisId, scheduledStart: new Date(Date.now() + 2 * 60000).toISOString(), scheduledEnd: new Date(Date.now() + 62 * 60000).toISOString() }), [201], "turno").shift;
      const sa = await call("POST", `/organizations/${N}/me/shifts/${shift.id}/self-assign`, tAna, {});
      const ci = await call("POST", `/organizations/${N}/shifts/${shift.id}/check-in`, tAna, { verificationMethodCode: "CAREGIVER_SESSION" });
      const ev = [await call("POST", `/organizations/${N}/shifts/${shift.id}/care-events`, tAna, { typeCode: "MEAL", careRecipientId: luisId, payload: { mealType: "Almuerzo", amountConsumed: "Mitad" } }),
        await call("POST", `/organizations/${N}/shifts/${shift.id}/care-events`, tAna, { typeCode: "HYDRATION", careRecipientId: luisId, payload: { amount: "Vaso completo" } })].map((r) => r.s);
      const co = await call("POST", `/organizations/${N}/shifts/${shift.id}/check-out`, tAna, {});
      ck("K7a práctica: cliente, turno con «Asignármelo», comenzar, registrar y finalizar", [200, 201].includes(sa.s) && [200, 201].includes(ci.s) && ev.every((s) => s === 201 || s === 200) && [200, 201].includes(co.s), { sa: sa.s, saE: sa.j.error, ci: ci.s, ev, co: co.s });
      const reps = (await call("GET", `/organizations/${N}/shifts/${shift.id}/shift-reports`, tAna)).j.reports ?? [];
      must(await call("PUT", `/organizations/${N}/practice/profile`, tAna, { professionalName: "Ana Demo" }), [200], "nombre profesional");
      const pub = reps[0] ? await call("POST", `/organizations/${N}/shift-reports/${reps[0].id}/publish-as-provider`, tAna, { expectedGeneratedAt: reps[0].generatedAt, familySections: { schedule: true, meals: true, hydration: true, activities: true, mobility: true, observations: true, hygiene: false, mood: false, incidents: false, photos: false } }) : { s: 0, j: {} };
      ck("K7b informe del proveedor: borrador generado y publicado por la propia práctica", reps.length === 1 && pub.s === 200, { reps: reps.length, pub: pub.s, e: pub.j.error });
      const fpw = "Verif-" + crypto.randomUUID();
      const finv = must(await call("POST", `/organizations/${N}/access-invitations`, tAna, { type: "family", email: "verificacion-familia@demo.invalid", careRecipientId: luisId, relationshipType: "hijo" }), [201], "familia de verificación");
      must(await call("POST", "/access-invitations/activate", undefined, { token: finv.token, password: fpw }), [200, 201], "activar familia de verificación");
      const tFv = must(await call("POST", "/auth/login", undefined, { email: "verificacion-familia@demo.invalid", password: fpw }), [200], "login familia de verificación").token;
      const fr = await call("GET", `/organizations/${N}/care-recipients/${luisId}/shift-reports`, tFv);
      const frOther = await call("GET", `/organizations/${L}/care-recipients`, tFv);
      ck("K7c familia: ve el informe del proveedor de su familiar y no entra a otra práctica", fr.s === 200 && (fr.j.reports ?? []).length >= 1 && [403, 404].includes(frOther.s), { fr: fr.s, n: (fr.j.reports ?? []).length, other: frOther.s });
      const docs = (await call("GET", `/organizations/${N}/practice/documents`, tAna)).j.documents ?? [];
      const up = docs[0] ? await call("POST", `/organizations/${N}/me/credentials/${docs[0].id}/documents/upload-url`, tAna, { originalFilename: "certificado-ficticio.pdf", contentType: "application/pdf", sizeBytes: PDF.length }) : { s: 0, j: {} };
      const put = up.j.upload ? await fetch(`${API}/organizations/${N}/me/credentials/${docs[0].id}/documents/${up.j.upload.fileId}/content`, { method: "POST", headers: { "Content-Type": "application/pdf", Authorization: `Bearer ${tAna}` }, body: PDF }) : null;
      ck("K7d documento autodeclarado: el archivo se guarda en el almacenamiento propio de la demo", !!put && put.ok, { up: up.s, put: put?.status });
    } catch (e) { ck("K7 recorrido completo de la práctica", false, (e as Error).message); }
  } else log("recorrido K7 ya hecho antes: no se repite");
  // K8 (Fase 1 final): prueba integral en la práctica de Ana con datos ficticios nuevos (una sola vez).
  const k8done = (await db.query(`SELECT 1 FROM care_recipients WHERE organization_id=$1 AND first_name='Marta'`, [N])).rowCount;
  if (!k8done) {
    try {
      const t0 = new Date().toISOString();
      const anaId = (await db.query(`SELECT id FROM users WHERE email=$1`, [ACCOUNTS.ana.email])).rows[0].id;
      must(await call("POST", "/me/active-organization", tAna, { organizationId: N }), [200], "Ana en su práctica");
      const docs = (await call("GET", `/organizations/${N}/practice/documents`, tAna)).j.documents ?? [];
      const rq = await call("GET", `/organizations/${A}/credentials/review-queue`, tA);
      const anaRev = (await db.query(`SELECT r.review_status FROM organization_credential_reviews r JOIN credentials c ON c.id=r.credential_id JOIN workers w ON w.id=c.worker_id WHERE w.user_id=$1`, [anaId])).rows.map((r) => r.review_status);
      ck("K8a documentos: los de la práctica son autodeclarados; la agencia los ve aparte y ninguno queda aprobado solo", docs.length >= 1 && docs.every((d: any) => d.declaredByHolder !== false) && rq.s === 200 && !anaRev.includes("approved"), { docs: docs.length, rq: rq.s, anaRev });
      const marta = must(await call("POST", `/organizations/${N}/care-recipients`, tAna, { firstName: "Marta", lastName: "Demo" }), [201], "cliente Marta");
      const mId = (marta.careRecipient ?? marta.recipient ?? marta).id;
      const fpw = "Verif-" + crypto.randomUUID();
      const finv = must(await call("POST", `/organizations/${N}/access-invitations`, tAna, { type: "family", email: "verificacion-familia-marta@demo.invalid", careRecipientId: mId, relationshipType: "hija" }), [201], "familia de Marta");
      must(await call("POST", "/access-invitations/activate", undefined, { token: finv.token, password: fpw }), [200, 201], "activar familia de Marta");
      const tFm = must(await call("POST", "/auth/login", undefined, { email: "verificacion-familia-marta@demo.invalid", password: fpw }), [200], "login familia de Marta").token;
      const at = (min: number) => new Date(Date.now() + min * 60000).toISOString();
      const s1 = must(await call("POST", `/organizations/${N}/shifts`, tAna, { careRecipientId: mId, scheduledStart: at(5), scheduledEnd: at(65) }), [201], "turno 1").shift.id;
      const sa1 = await call("POST", `/organizations/${N}/me/shifts/${s1}/self-assign`, tAna, {});
      const a1 = await call("POST", `/organizations/${N}/shifts/${s1}/arrival`, tAna, { clientEventId: crypto.randomUUID() });
      const memb = (await db.query(`SELECT organization_worker_membership_id m FROM shift_arrivals WHERE shift_id=$1`, [s1])).rows[0]?.m;
      const rv = await call("POST", `/organizations/${N}/shifts/${s1}/arrival/review`, tAna, { membershipId: memb, note: "autorrevisión de prueba" });
      ck("K8b «Asignármelo» y llegada sin GPS: queda «no verificada»; la autorrevisión se rechaza (409)", [200, 201].includes(sa1.s) && a1.s === 201 && (a1.j.arrival ?? a1.j).needsReview === true && rv.s === 409, { sa1: sa1.s, sa1E: sa1.j.error, a1: a1.s, arr: a1.j, rv: rv.s });
      await db.query(`INSERT INTO care_recipient_locations (care_recipient_id, organization_id, address_line, municipality, latitude, longitude, is_primary, gps_confirmed_at, gps_confirmed_by_user_id) VALUES ($1,$2,'Calle Ficticia 1','San Juan',18.465500,-66.105700,true,now(),$3)`, [mId, N, anaId]);
      const s2 = must(await call("POST", `/organizations/${N}/shifts`, tAna, { careRecipientId: mId, scheduledStart: at(90), scheduledEnd: at(150) }), [201], "turno 2").shift.id;
      await call("POST", `/organizations/${N}/me/shifts/${s2}/self-assign`, tAna, {});
      const cons = await call("POST", `/organizations/${N}/me/location-consent`, tAna, { consentVersion: "location-check-v1" });
      const a2 = await call("POST", `/organizations/${N}/shifts/${s2}/arrival`, tAna, { latitude: 18.2, longitude: -66.5, accuracyM: 10, clientEventId: crypto.randomUUID() });
      const st = (await db.query(`SELECT proximity, needs_review, reviewed_at FROM shift_arrivals WHERE shift_id = ANY($1::uuid[])`, [[s1, s2]])).rows;
      ck("K8c llegada fuera del perímetro (~51 km): FAR, no verificada; ninguna llegada queda aprobada", cons.s < 300 && a2.s === 201 && (a2.j.arrival ?? a2.j).proximity === "FAR" && st.length === 2 && st.every((r) => r.needs_review && r.reviewed_at === null), { cons: cons.s, a2: a2.s, a2j: a2.j, st });
      const ci = await call("POST", `/organizations/${N}/shifts/${s1}/check-in`, tAna, { verificationMethodCode: "CAREGIVER_SESSION" });
      const ev = await call("POST", `/organizations/${N}/shifts/${s1}/care-events`, tAna, { typeCode: "MEAL", careRecipientId: mId, payload: { mealType: "Almuerzo", amountConsumed: "Todo" } });
      const co = await call("POST", `/organizations/${N}/shifts/${s1}/check-out`, tAna, {});
      const reps = (await call("GET", `/organizations/${N}/shifts/${s1}/shift-reports`, tAna)).j.reports ?? [];
      const pub = reps[0] ? await call("POST", `/organizations/${N}/shift-reports/${reps[0].id}/publish-as-provider`, tAna, { expectedGeneratedAt: reps[0].generatedAt, familySections: { schedule: true, meals: true, hydration: true, activities: true, mobility: true, observations: true, hygiene: false, mood: false, incidents: false, photos: false } }) : { s: 0, j: {} };
      const fr = await call("GET", `/organizations/${N}/care-recipients/${mId}/shift-reports`, tFm);
      ck("K8d visita e informe: comenzar, registrar, finalizar, publicar; la familia de Marta lo ve", [200, 201].includes(ci.s) && [200, 201].includes(ev.s) && [200, 201].includes(co.s) && pub.s === 200 && fr.s === 200 && (fr.j.reports ?? []).length >= 1, { ci: ci.s, ev: ev.s, co: co.s, reps: reps.length, pub: pub.s, pubE: pub.j.error, fr: fr.s });
      await sleep(1500);
      const self = (await db.query(`SELECT notification_type t FROM notifications WHERE user_id=$1 AND organization_id=$2 AND created_at >= $3`, [anaId, N, t0])).rows.map((r) => r.t);
      const fam = (await db.query(`SELECT n.notification_type t FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.email='verificacion-familia-marta@demo.invalid'`)).rows.map((r) => r.t);
      ck("K8e notificaciones: Ana no recibe avisos sobre sí misma en su práctica; la familia sí recibe los suyos", self.length === 0 && fam.length >= 1, { self, fam });
      const luisId = (await db.query(`SELECT id FROM care_recipients WHERE organization_id=$1 AND first_name='Luis'`, [N])).rows[0]?.id;
      const restr = {
        revisarCredencial: (await call("POST", `/organizations/${N}/workers/${memb}/credentials/${docs[0]?.id ?? crypto.randomUUID()}/review`, tAna, { decision: "approved" })).s,
        familiaEnOtraPractica: (await call("GET", `/organizations/${L}/care-recipients`, tFm)).s,
        familiaEnAgencia: (await call("GET", `/organizations/${A}/care-recipients`, tFm)).s,
        familiaInformeAjeno: (await call("GET", `/organizations/${N}/care-recipients/${luisId}/shift-reports`, tFm)).s,
        practicaInterruptor: (await call("PATCH", "/platform/modalities/INDEPENDENT_PROVIDER", tAna, { enabled: true, reason: "intento de prueba" })).s,
      };
      ck("K8f restricciones: la práctica no revisa credenciales ni toca el interruptor; la familia no ve otras organizaciones ni informes ajenos", restr.revisarCredencial === 403 && [403, 404].includes(restr.familiaEnOtraPractica) && [403, 404].includes(restr.familiaEnAgencia) && [403, 404].includes(restr.familiaInformeAjeno) && restr.practicaInterruptor === 403, restr);
      const nr = {
        agenciaClientes: (await call("GET", `/organizations/${A}/care-recipients`, tA)).s, agenciaTurnos: (await call("GET", `/organizations/${A}/shifts`, tA)).s,
        agenciaPersonal: (await call("GET", `/organizations/${A}/workers`, tA)).s, agenciaCola: rq.s,
        hogarEstablecimientos: (await call("GET", `/organizations/${H}/establishments`, tH)).s, hogarTurnos: (await call("GET", `/organizations/${H}/shifts`, tH)).s,
      };
      ck("K8g agencia y hogar sin regresión: clientes, turnos, personal, cola de credenciales, establecimientos (200)", Object.values(nr).every((s) => s === 200), nr);
    } catch (e) { ck("K8 prueba integral", false, (e as Error).message); }
  } else log("prueba integral K8 ya hecha antes: no se repite");

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
