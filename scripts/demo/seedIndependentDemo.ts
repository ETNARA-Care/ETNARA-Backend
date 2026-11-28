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
  else must(await call("POST", "/platform/admin-invitations/activate", undefined, { token, password: a.pw(), professionalName: `${a.email.split("@")[0]} Demo (ficticia)` }), [201], `activar ${a.email}`);
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
  const k8done = (await db.query(`SELECT 1 FROM care_recipients WHERE organization_id=$1 AND first_name='Elena' AND last_name='Final2'`, [N])).rowCount;
  if (!k8done) {
    // Las prácticas de la demo se crearon antes de la 164: se les dan los valores por defecto de una práctica nueva.
    for (const org of [N, L]) for (const f of ["EN_CAMINO", "SHIFT_REPORTS"]) {
      const on = (await db.query(`SELECT 1 FROM organization_features WHERE organization_id=$1 AND feature_code=$2 AND enabled`, [org, f])).rowCount;
      if (!on) must(await call("PUT", `/platform/organizations/${org}/features/${f}`, C, { enabled: true, reason: "Demo: valores por defecto de una práctica nueva (164)" }), [200], `${f} en la práctica`);
    }
    try {
      const t0 = new Date().toISOString();
      const anaId = (await db.query(`SELECT id FROM users WHERE email=$1`, [ACCOUNTS.ana.email])).rows[0].id;
      must(await call("POST", "/me/active-organization", tAna, { organizationId: N }), [200], "Ana en su práctica");
      const docs = (await call("GET", `/organizations/${N}/practice/documents`, tAna)).j.documents ?? [];
      const rq = await call("GET", `/organizations/${A}/credentials/review-queue`, tA);
      const anaRev = (await db.query(`SELECT r.review_status FROM organization_credential_reviews r JOIN credentials c ON c.id=r.credential_id JOIN workers w ON w.id=c.worker_id WHERE w.user_id=$1`, [anaId])).rows.map((r) => r.review_status);
      ck("K8a documentos: los de la práctica son autodeclarados; la agencia los ve aparte y ninguno queda aprobado solo", docs.length >= 1 && docs.every((d: any) => d.declaredByHolder !== false) && rq.s === 200 && !anaRev.includes("approved"), { docs: docs.length, rq: rq.s, anaRev });
      const marta = must(await call("POST", `/organizations/${N}/care-recipients`, tAna, { firstName: "Elena", lastName: "Final2" }), [201], "cliente Elena");
      const mId = (marta.careRecipient ?? marta.recipient ?? marta).id;
      const fpw = "Verif-" + crypto.randomUUID();
      const finv = must(await call("POST", `/organizations/${N}/access-invitations`, tAna, { type: "family", email: "verificacion-familia-elena3@demo.invalid", careRecipientId: mId, relationshipType: "hija" }), [201], "familia de Elena");
      must(await call("POST", "/access-invitations/activate", undefined, { token: finv.token, password: fpw }), [200, 201], "activar familia de Elena");
      const tFm = must(await call("POST", "/auth/login", undefined, { email: "verificacion-familia-elena3@demo.invalid", password: fpw }), [200], "login familia de Elena").token;
      // Turnos de prueba anteriores (Marta y Elena, de intentos previos de K8) se cancelan para no chocar en el horario.
      for (const r of (await db.query(`SELECT s.id FROM shifts s JOIN care_recipients c ON c.id=s.care_recipient_id WHERE s.organization_id=$1 AND c.first_name IN ('Marta','Elena') AND s.status::text NOT IN ('completed','cancelled')`, [N])).rows)
        await call("POST", `/organizations/${N}/shifts/${r.id}/cancel`, tAna, {});
      // Después del último turno vigente de la práctica (un turno terminado sigue ocupando su horario).
      const busy = (await db.query(`SELECT max(scheduled_end) e FROM shifts WHERE organization_id=$1 AND status::text <> 'cancelled' AND scheduled_end > now()`, [N])).rows[0].e;
      const base = Math.max(Date.now(), busy ? new Date(busy).getTime() : 0) + 2 * 60000;
      const at = (min: number) => new Date(base + min * 60000).toISOString();
      const s1 = must(await call("POST", `/organizations/${N}/shifts`, tAna, { careRecipientId: mId, scheduledStart: at(0), scheduledEnd: at(20) }), [201], "turno 1").shift.id;
      const sa1 = await call("POST", `/organizations/${N}/me/shifts/${s1}/self-assign`, tAna, {});
      const a1 = await call("POST", `/organizations/${N}/shifts/${s1}/arrival`, tAna, { clientEventId: crypto.randomUUID() });
      const memb = (await db.query(`SELECT organization_worker_membership_id m FROM shift_arrivals WHERE shift_id=$1`, [s1])).rows[0]?.m;
      const rv = await call("POST", `/organizations/${N}/shifts/${s1}/arrival/review`, tAna, { membershipId: memb, note: "autorrevisión de prueba" });
      ck("K8b «Asignármelo» y llegada sin GPS: queda «no verificada»; la autorrevisión se rechaza (409)", [200, 201].includes(sa1.s) && a1.s === 201 && (a1.j.arrival ?? a1.j).needsReview === true && rv.s === 409, { sa1: sa1.s, sa1E: sa1.j.error, a1: a1.s, arr: a1.j, rv: rv.s });
      await db.query(`INSERT INTO care_recipient_locations (care_recipient_id, organization_id, address_line, municipality, latitude, longitude, is_primary, gps_confirmed_at, gps_confirmed_by_user_id) VALUES ($1,$2,'Calle Ficticia 1','San Juan',18.465500,-66.105700,true,now(),$3)`, [mId, N, anaId]);
      const s2 = must(await call("POST", `/organizations/${N}/shifts`, tAna, { careRecipientId: mId, scheduledStart: at(22), scheduledEnd: at(42) }), [201], "turno 2").shift.id;
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
      ck("K8d visita e informe: comenzar, registrar, finalizar, publicar; la familia de Elena lo ve", [200, 201].includes(ci.s) && [200, 201].includes(ev.s) && [200, 201].includes(co.s) && pub.s === 200 && fr.s === 200 && (fr.j.reports ?? []).length >= 1, { ci: ci.s, ev: ev.s, co: co.s, reps: reps.length, pub: pub.s, pubE: pub.j.error, fr: fr.s });
      await sleep(1500);
      const self = (await db.query(`SELECT notification_type t FROM notifications WHERE user_id=$1 AND organization_id=$2 AND created_at >= $3`, [anaId, N, t0])).rows.map((r) => r.t);
      const fam = (await db.query(`SELECT n.notification_type t FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.email='verificacion-familia-elena3@demo.invalid'`)).rows.map((r) => r.t);
      ck("K8e notificaciones: Ana no recibe avisos sobre sí misma en su práctica; la familia sí recibe los suyos", self.length === 0 && fam.length >= 1, { self, fam });
      const luisId = (await db.query(`SELECT id FROM care_recipients WHERE organization_id=$1 AND first_name='Luis'`, [N])).rows[0]?.id;
      const restr = {
        revisarCredencial: (await call("POST", `/organizations/${N}/workers/${(await db.query(`SELECT owm.id FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id WHERE w.user_id=$1 AND owm.organization_id=$2`, [anaId, N])).rows[0]?.id}/credentials/${docs[0]?.id ?? crypto.randomUUID()}/review`, tAna, { decision: "approved" })).s,
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
  // K9 (seguridad #286): las variantes de dirección no eluden las guardas. Solo lecturas (GET); no crea nada.
  try {
    const enc = (id: string) => "%" + id.charCodeAt(0).toString(16) + id.slice(1);
    const variants = (org: string, rest: string) => [`/organizations/${org}${rest}`, `/organizations/${enc(org)}${rest}`, `/organizations/${org}${rest}/`, `/ORGANIZATIONS/${org}${rest.toUpperCase()}/`];
    const feats = Object.fromEntries((await db.query(`SELECT organization_id::text o, feature_code f, enabled e FROM organization_features`)).rows.map((r) => [`${r.o}:${r.f}`, r.e]));
    const cand: Array<[string, string, string, string]> = [];
    for (const [org, tok] of [[A, tA], [H, tH]] as const) for (const [f, rest] of [["SMARTMATCH", "/smartmatch/opportunities"], ["FINANZAS", "/finance/clients"], ["SHIFT_REPORTS", "/shift-reports"]] as const)
      if (!feats[`${org}:${f}`]) cand.push([org, tok, f, rest]);
    const off: Record<string, number | string> = {};
    for (const [org, tok, f, rest] of cand.slice(0, 3)) for (const p of variants(org, rest)) { const r = await call("GET", p, tok); off[`${f} ${p.replace(org, "ORG").replace(enc(org), "%ORG")}`] = r.s === 404 ? (r.j.error ?? "404") : r.s; }
    ck("K9a interruptores apagados: ninguna variante (id codificado, barra final, mayúsculas) abre la funcionalidad", cand.length > 0 && Object.values(off).every((v) => v === "FEATURE_NOT_ENABLED" || v === "404"), { n: cand.length, off });
    const team: Record<string, number | string> = {};
    for (const rest of ["/team", "/smartmatch/opportunities", "/credentials/review-queue"]) for (const p of variants(N, rest)) { const r = await call("GET", p, tAna); team[`${rest} ${p.replace(N, "ORG").replace(enc(N), "%ORG")}`] = r.s === 403 ? (r.j.error ?? "403") : r.s; }
    ck("K9b práctica independiente: ninguna variante abre rutas de equipo (403 MODALITY_NOT_AVAILABLE)", Object.values(team).every((v) => v === "MODALITY_NOT_AVAILABLE" || v === 404), team);
    const legit = { agencia: (await call("GET", `/organizations/${A}/care-recipients`, tA)).s, agenciaCodificada: (await call("GET", `/organizations/${enc(A)}/care-recipients`, tA)).s,
      practica: (await call("GET", `/organizations/${N}/care-recipients`, tAna)).s, practicaCodificada: (await call("GET", `/organizations/${enc(N)}/care-recipients`, tAna)).s,
      hogar: (await call("GET", `/organizations/${H}/establishments`, tH)).s, hogarBarra: (await call("GET", `/organizations/${H}/establishments/`, tH)).s,
      ajenoCodificado: (await call("GET", `/organizations/${enc(A)}/care-recipients`, tH)).s };
    ck("K9c accesos legítimos iguales con variantes (200) y una organización ajena sigue cerrada (403)", legit.agencia === 200 && legit.agenciaCodificada === 200 && legit.practica === 200 && legit.practicaCodificada === 200 && legit.hogar === 200 && legit.hogarBarra === 200 && legit.ajenoCodificado === 403, legit);
  } catch (e) { ck("K9 variantes de dirección", false, (e as Error).message); }
  // K10 (hogares F2–F4 y F3): carga ficticia de Hogar Demo (una sola vez) y autocomprobación en cada arranque.
  try {
    const H = ids["Hogar Demo"];
    const L = (await db.query(`SELECT id FROM locations WHERE organization_id=$1 AND name='Residencia Demo Las Palmas'`, [H])).rows[0]?.id as string;
    const R = `/organizations/${H}/residential`, S = `${R}/schedule`, AS = `${R}/assignments`, SU = `${R}/substitutions`, PU = `${R}/attendance`;
    const prLocal = (d: Date) => new Date(d.getTime() - 4 * 3_600_000).toISOString().slice(0, 16);
    const mondayOf = (d: Date) => { const l = new Date(d.getTime() - 4 * 3_600_000); const wd = (l.getUTCDay() + 6) % 7; return new Date(l.getTime() - wd * 86_400_000).toISOString().slice(0, 10); };
    const prAt = (dayOffset: number, hh: number) => { const l = new Date(Date.now() - 4 * 3_600_000); const base = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + dayOffset, hh, 0); return new Date(base + 4 * 3_600_000); };
    const STAFF = [
      { key: "marisol", name: "Marisol Demo (ficticia)", pw: env("DEMO_PW_HOGAR_CUIDADORA"), eligible: true },
      { key: "luisa", name: "Luisa Demo (ficticia)", pw: "", eligible: true },
      { key: "ramon", name: "Ramón Demo (ficticio)", pw: "", eligible: true },
      { key: "teresa", name: "Teresa Demo (ficticia)", pw: "", eligible: true },
      { key: "nuevo", name: "Personal Nuevo Demo (ficticio, sin credenciales)", pw: "", eligible: false },
    ];
    const done = (await db.query(`SELECT 1 FROM users WHERE email='marisol@demo.invalid'`)).rowCount;
    if (!done) {
      for (const f of ["HOGAR_CALENDARIO", "HOGAR_ASIGNACIONES", "HOGAR_PONCHES", "DEMO_ENVIRONMENT"])
        must(await call("PUT", `/platform/organizations/${H}/features/${f}`, C, { enabled: true, reason: "Demo aislada de hogares con datos ficticios" }), [200], `interruptor ${f}`);
      const cred = (await db.query(`SELECT id FROM credential_types ORDER BY code LIMIT 1`)).rows[0].id;
      if (!(await db.query(`SELECT 1 FROM requirement_sets WHERE organization_id=$1`, [H])).rowCount) {
        const rs = (await db.query(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Requisitos ficticios del hogar') RETURNING id`, [H])).rows[0].id;
        await db.query(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, cred]);
      }
      await db.query(`INSERT INTO organization_care_event_types (organization_id,care_event_type_id,is_enabled) SELECT $1,id,true FROM care_event_types ON CONFLICT DO NOTHING`, [H]);
      const rooms: string[] = [];
      for (let i = 1; i <= 4; i++) rooms.push(must(await call("POST", `${R}/establishments/${L}/rooms`, tH, { name: `Habitación ${100 + i}`, bedCapacity: 2 }), [201], `habitación ${i}`).room.id);
      must(await call("PUT", `${R}/establishments/${L}/geofence`, tH, { radiusMeters: 100, latitude: 18.401234, longitude: -66.051234, reason: "Centro ficticio de la demo (no corresponde a ningún lugar real)" }), [200], "geocerca");
      const rosa = (await db.query(`SELECT id FROM care_recipients WHERE organization_id=$1 AND first_name='Rosa'`, [H])).rows[0].id;
      const res: string[] = [rosa];
      for (const n of ["Gloria", "Héctor", "Irma", "Julio", "Nilda"])
        res.push((await db.query(`INSERT INTO care_recipients (organization_id,location_id,first_name,last_name,status) VALUES ($1,$2,$3,'Demo (ficticio)','active') RETURNING id`, [H, L, n])).rows[0].id);
      for (let i = 0; i < res.length; i++) must(await call("PUT", `${R}/residents/${res[i]}/placement`, tH, { roomId: rooms[Math.floor(i / 2)], reason: "Ingreso ficticio de la demo" }), [200], `ubicar residente ${i}`);
      const { hashPassword } = await import("../../src/security/password.js");
      const st: Record<string, { userId: string; owm: string; token: string }> = {};
      for (const p of STAFF) {
        const email = `${p.key}@demo.invalid`, pw = p.pw || `Demo-${crypto.randomUUID()}`;
        const userId = (await db.query(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, await hashPassword(pw)])).rows[0].id;
        const m = (await db.query(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, H])).rows[0].id;
        await db.query(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='WORKER'`, [m, H]);
        const w = (await db.query(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, p.name])).rows[0].id;
        const owm = (await db.query(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, H])).rows[0].id;
        if (p.eligible) await db.query(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [w, cred]);
        await db.query(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id) VALUES ($1,$2,$3)`, [H, L, owm]);
        const token = must(await call("POST", "/auth/login", undefined, { email, password: pw }), [200], `login ${p.key}`).token;
        await call("POST", "/me/active-organization", token, { organizationId: H });
        st[p.key] = { userId, owm, token };
      }
      // Esta semana: un turno esta noche (para ponchar ya) y turnos de los dos días siguientes.
      const t0 = new Date(Math.ceil((Date.now() + 30 * 60_000) / (30 * 60_000)) * 30 * 60_000);
      const plan: Array<[string, Date, number, string]> = [
        ["marisol", t0, 240, "Demo esta noche"],
        ["marisol", prAt(1, 8), 480, "Día"], ["luisa", prAt(1, 8), 480, "Día"], ["ramon", prAt(1, 16), 480, "Tarde"],
        ["marisol", prAt(2, 8), 480, "Día"], ["teresa", prAt(2, 8), 480, "Día"],
      ];
      const shift: Record<string, string> = {}; const weeks = new Set<string>();
      for (const [k, at, dur, label] of plan) {
        const wk = mondayOf(at); weeks.add(wk);
        const e = must(await call("POST", `${S}/establishments/${L}/weeks/${wk}/entries`, tH, { startsAt: prLocal(at), durationMinutes: dur, membershipId: st[k].owm, label }), [201], `turno ${k} ${label}`).entry;
        shift[`${k}:${label}:${at.toISOString()}`] = e.id;
      }
      for (const wk of weeks) must(await call("POST", `${S}/establishments/${L}/weeks/${wk}/publish`, tH, {}), [200], `publicar ${wk}`);
      const sid = async (entryId: string) => (await db.query(`SELECT shift_id FROM schedule_week_shifts WHERE id=$1`, [entryId])).rows[0].shift_id as string;
      const [eTonight, eM1, eL1, eR1, , eT2] = Object.values(shift);
      const [sTonight, sM1, sL1, sR1, sT2] = [await sid(eTonight), await sid(eM1), await sid(eL1), await sid(eR1), await sid(eT2)];
      for (const [k, s] of [["marisol", sTonight], ["marisol", sM1], ["luisa", sL1], ["ramon", sR1], ["teresa", sT2]] as const)
        must(await call("POST", `/organizations/${H}/me/shifts/${s}/respond`, st[k].token, { decision: "accepted" }), [200], `aceptar ${k}`);
      // La semana siguiente: plantilla de día, tarde y noche, con parte del personal asignado, publicada.
      const next = mondayOf(new Date(Date.now() + 7 * 86_400_000));
      if (!weeks.has(next)) {
        const slots = [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => [
          { weekday, startTime: "07:00", durationMinutes: 480, headcount: 2, label: "Día" },
          { weekday, startTime: "15:00", durationMinutes: 480, headcount: 2, label: "Tarde" },
          { weekday, startTime: "23:00", durationMinutes: 480, headcount: 1, label: "Noche" }]);
        const tpl = must(await call("POST", `${S}/establishments/${L}/templates`, tH, { name: "Día, tarde y noche (demo)", slots }), [201], "plantilla").template;
        must(await call("POST", `${S}/establishments/${L}/weeks/${next}/apply-template`, tH, { templateId: tpl.id }), [200], "aplicar plantilla");
        const entries = (must(await call("GET", `${S}/establishments/${L}/weeks/${next}`, tH), [200], "semana siguiente").schedule.entries ?? []) as any[];
        const rot = ["marisol", "luisa", "ramon", "teresa"]; let k = 0;
        for (const e of entries.filter((x) => x.label === "Día").slice(0, 10)) await call("PATCH", `${S}/entries/${e.id}`, tH, { membershipId: st[rot[k++ % 4]].owm });
        must(await call("POST", `${S}/establishments/${L}/weeks/${next}/publish`, tH, {}), [200], "publicar semana siguiente");
      }
      // F3: residentes asignados por turno y una sustitución completa (Ramón → Teresa).
      must(await call("POST", `${AS}/shifts/${sTonight}/residents`, tH, { membershipId: st.marisol.owm, careRecipientIds: res.slice(0, 3) }), [201], "asignar esta noche");
      must(await call("POST", `${AS}/shifts/${sM1}/residents`, tH, { membershipId: st.marisol.owm, careRecipientIds: res.slice(0, 3) }), [201], "asignar Marisol");
      must(await call("POST", `${AS}/shifts/${sL1}/residents`, tH, { membershipId: st.luisa.owm, careRecipientIds: res.slice(3, 6) }), [201], "asignar Luisa");
      must(await call("POST", `${AS}/shifts/${sR1}/residents`, tH, { membershipId: st.ramon.owm, careRecipientIds: res.slice(0, 4) }), [201], "asignar Ramón");
      must(await call("POST", `${SU}/shifts/${sR1}`, tH, { originalMembershipId: st.ramon.owm, substituteMembershipId: st.teresa.owm, reasonCode: "schedule_change",
        transfers: res.slice(0, 4).map((r) => ({ careRecipientId: r, toMembershipId: st.teresa.owm })) }), [201], "sustitución Ramón → Teresa");
      log(`Hogar Demo: 4 habitaciones, 6 residentes, 5 personas, turnos de esta semana y la siguiente, asignaciones y una sustitución (todo ficticio)`);
    } else log("carga de Hogar Demo (K10) ya hecha antes: no se repite");

    // K11 (27-nov, a pedido de Rafa): quitar los borradores de la semana en curso (plantilla aplicada a una semana ya empezada,
    // que no se puede publicar por tener turnos en el pasado) y apagar DEMO_ENVIRONMENT (su franja choca con la cabecera; la demo ya tiene la suya).
    {
      const drafts = (await db.query(`SELECT e.id FROM schedule_week_shifts e JOIN schedule_weeks w ON w.id=e.week_id
        WHERE w.organization_id=$1 AND w.location_id=$2 AND w.week_start=$3::date AND e.shift_id IS NULL AND e.removed_at IS NULL`, [H, L, mondayOf(new Date())])).rows.map((r) => r.id as string);
      let removed = 0; for (const id of drafts) if ((await call("DELETE", `${S}/entries/${id}`, tH)).s === 200) removed++;
      if (drafts.length) log(`semana en curso: ${removed} de ${drafts.length} borradores quitados (los turnos publicados no se tocan)`);
      const de = (await db.query(`SELECT enabled FROM organization_features WHERE organization_id=$1 AND feature_code='DEMO_ENVIRONMENT'`, [H])).rows[0]?.enabled;
      if (de) { must(await call("PUT", `/platform/organizations/${H}/features/DEMO_ENVIRONMENT`, C, { enabled: false, reason: "Demo: su franja se superpone a la cabecera; la demo ya muestra su propia franja DEMO" }), [200], "apagar DEMO_ENVIRONMENT"); log("DEMO_ENVIRONMENT apagado en Hogar Demo"); }
    }

    const mar = must(await call("POST", "/auth/login", undefined, { email: "marisol@demo.invalid", password: env("DEMO_PW_HOGAR_CUIDADORA") }), [200], "login Marisol").token;
    await call("POST", "/me/active-organization", mar, { organizationId: H });
    const ov = await call("GET", `${R}/overview`, tH);
    const on = (ov.j.overview?.features ?? []).filter((f: any) => f.enabled).map((f: any) => f.code ?? f.feature);
    ck("K10a Hogar Demo: calendario, asignaciones y ponches encendidos solo en la demo", ov.s === 200 && on.length >= 3, { s: ov.s, on });
    const wk = mondayOf(new Date());
    const week = await call("GET", `${S}/establishments/${L}/weeks/${wk}`, tH);
    const pendingDrafts = ((week.j.schedule?.entries ?? []) as any[]).filter((e) => e.published === false).length;
    ck("K11 semana en curso sin borradores pendientes de publicar", week.s === 200 && pendingDrafts === 0, { pendingDrafts });
    const nextW = await call("GET", `${S}/establishments/${L}/weeks/${mondayOf(new Date(Date.now() + 7 * 86_400_000))}`, tH);
    ck("K10b calendario semanal: esta semana y la siguiente con turnos", week.s === 200 && nextW.s === 200 && (week.j.schedule?.entries ?? []).length + (nextW.j.schedule?.entries ?? []).length >= 6, { a: week.s, b: nextW.s, n: [(week.j.schedule?.entries ?? []).length, (nextW.j.schedule?.entries ?? []).length] });
    const mine = await call("GET", `${S}/me/weeks/${wk}`, mar);
    const mineE = (mine.j.schedule?.entries ?? mine.j.schedule?.shifts ?? []) as any[];
    ck("K10c «Mi horario» de Marisol: solo sus turnos publicados", mine.s === 200 && mineE.length >= 1 && !JSON.stringify(mine.j).includes("Luisa Demo"), { s: mine.s, n: mineE.length });
    const codes = await call("GET", `${PU}/establishments/${L}/codes`, tH);
    ck("K10d ponches: secreto de la demo configurado y código de la semana disponible (sin 503)", codes.s === 200, { s: codes.s, e: codes.j.error });
    const subId = (await db.query(`SELECT shift_id FROM shift_substitutions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`, [H])).rows[0]?.shift_id;
    const hist = subId ? await call("GET", `${AS}/shifts/${subId}/history`, tH) : { s: 0, j: {} };
    ck("K10e F3: la sustitución Ramón → Teresa queda en el historial del turno", hist.s === 200 && JSON.stringify(hist.j).length > 20, { s: hist.s });
    const ag = await call("GET", `/organizations/${ids["Agencia Demo"]}/residential/overview`, tA);
    const agOk = await call("GET", `/organizations/${ids["Agencia Demo"]}/shifts`, tA);
    ck("K10f la agencia sigue igual y no entra a /residential (403)", ag.s === 403 && agOk.s === 200, { ag: ag.s, ok: agOk.s });
  } catch (e) { ck("K10 Hogar Demo", false, (e as Error).message); }



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
