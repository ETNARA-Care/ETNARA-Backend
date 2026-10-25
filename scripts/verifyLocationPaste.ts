/**
 * «Pegar ubicación» (migration 122), end to end over HTTP as app_runtime.
 * A relative proposes the exact point (PIN); the agency reviews it; approving applies
 * it UNCONFIRMED (caregivers never navigate to it until a manager confirms it).
 * Plus the short-link resolver (POST /maps/resolve-link) with an in-process fake
 * provider: nothing is fetched from the Internet. Synthetic data only.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

// Fake map provider (in process): records every outgoing request; anything else is refused.
const outgoing: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://maps.app.goo.gl/") || url.startsWith("https://maps.apple/")) {
    outgoing.push(url);
    const target = url.includes("Fuera") ? "https://www.google.com/maps?q=40.7128,-74.0060"
      : url.startsWith("https://maps.apple/") ? "https://maps.apple.com/place?coordinate=18.2341,-66.0485&name=Casa"
      : "https://www.google.com/maps/place/Casa/@18.23,-66.04,17z/data=!3d18.2341!4d-66.0485";
    return new Response(null, { status: 302, headers: { location: target } });
  }
  if (/^https?:\/\/127\.0\.0\.1/.test(url)) return realFetch(input as never, init);
  outgoing.push(url);
  throw new Error("Unexpected outbound request in verifier");
}) as typeof fetch;

const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); if (level === "error") original(...args); };
}
const out = (line: string) => process.stdout.write(line + "\n");

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 40) }; }
    return { status: res.status, body: parsed };
  }
  const org = async (name: string) =>
    (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['EN_CAMINO']) c) SELECT id FROM o`, [name])).rows[0].id;
  const orgA = await org(`LP A ${tag}`);
  const orgB = await org(`LP B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'LP') RETURNING id`, [orgA])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  type P = { email: string; userId: string; token: string; membershipId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `lp-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let membershipId: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Sintética ${key}`])).rows[0].id;
      membershipId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [membershipId, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [membershipId, orgId, d]);
    }
    return { email, userId, token: "", membershipId };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), cg: await person("a-cg", orgA, ["WORKER"], true),
    family: await person("a-family", orgA, ["FAMILY"]), family2: await person("a-family2", orgA, ["FAMILY"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), family: await person("b-family", orgB, ["FAMILY"]) };
  const recipient = async (o: string, last: string) =>
    (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [o, `${last}-${tag}`])).rows[0].id;
  const rA = await recipient(orgA, "Casa");
  const rA2 = await recipient(orgA, "Nueva");
  const rB = await recipient(orgB, "B");
  for (const [p, o, r, rel] of [[A.family, orgA, rA, "hija"], [A.family2, orgA, rA2, "nieto"], [B.family, orgB, rB, "hijo"]] as const) {
    await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,$4,'active')`, [p.userId, o, r, rel]);
  }
  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), ...Object.values(B).map((p) => [p, orgB] as const)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  const L = `/organizations/${orgA}/care-recipients/${rA}`;
  const F = `/me/care-recipients/${rA}/location-change-requests`;
  const notices = async (p: P, type: string) => ((await call("GET", "/me/notifications?limit=100", p.token)).body.items ?? [] as Json[]).filter((n: Json) => n.type === type);
  const primaryRow = async (r = rA) => (await q<Json>(`SELECT latitude::float8 AS latitude, longitude::float8 AS longitude, address_line, gps_confirmed_at, verified_at FROM care_recipient_locations WHERE care_recipient_id=$1 AND is_primary AND archived_at IS NULL`, [r])).rows[0];
  const PIN = { latitude: 18.2341, longitude: -66.0485 };

  try {
    // ------------------------------------------------------------ setup: official address with a CONFIRMED point and an assigned upcoming shift
    const created = await call("POST", `${L}/service-locations`, A.admin.token, { addressLine: "Calle Luna 12", municipality: "Caguas", postalCode: "00725" });
    const locId = created.body.location?.id as string;
    await call("POST", `${L}/service-locations/${locId}/confirm-gps`, A.admin.token, { latitude: 18.2300, longitude: -66.0400, confirm: true });
    const s = new Date(Date.now() + 3 * 86400e3); s.setUTCMinutes(0, 0, 0);
    const shift = await call("POST", `/organizations/${orgA}/shifts`, A.admin.token, { careRecipientId: rA, scheduledStart: s.toISOString(), scheduledEnd: new Date(s.getTime() + 4 * 3600e3).toISOString() });
    const shiftId = shift.body.shift?.id as string;
    await call("POST", `/organizations/${orgA}/shifts/${shiftId}/assignments`, A.admin.token, { organizationWorkerMembershipId: A.cg.membershipId });
    await call("POST", `/organizations/${orgA}/me/shifts/${shiftId}/respond`, A.cg.token, { decision: "accepted" });
    const before = await primaryRow();
    check("S0 setup: official address with a confirmed point and an assigned upcoming shift", created.status === 201 && !!before?.gps_confirmed_at && !!shiftId, `${created.status} gps=${!!before?.gps_confirmed_at}`);

    // ------------------------------------------------------------ P: the relative proposes a PIN
    const bad = await Promise.all([
      call("POST", F, A.family.token, { latitude: 40.7128, longitude: -74.006 }),
      call("POST", F, A.family.token, { latitude: 18.2341 }),
      call("POST", F, A.family.token, { latitude: "18.2", longitude: "-66.0" }),
      call("POST", F, A.family.token, {}),
    ]);
    check("P1 refused: point outside Puerto Rico, only one coordinate, text coordinates, empty request (400)", bad.every((r) => r.status === 400), bad.map((r) => r.status).join("/"));
    const onlyPin = await call("POST", F, A.family.token, PIN);
    check("P2 a relative can propose only the PIN (201); a short message is added for the agency", onlyPin.status === 201, `${onlyPin.status}`);
    const stored = (await q<Json>(`SELECT proposed_latitude::float8 AS lat, proposed_longitude::float8 AS lng, message, status FROM care_recipient_location_change_requests WHERE id=$1`, [onlyPin.body.request?.id])).rows[0];
    check("P3 stored as a PENDING proposal with the exact point; the official address is untouched",
      stored?.lat === PIN.latitude && stored?.lng === PIN.longitude && stored?.status === "PENDING" && /mapa/.test(stored?.message ?? "")
        && JSON.stringify(await primaryRow()) === JSON.stringify(before), JSON.stringify(stored));
    const second = await call("POST", F, A.family.token, { addressLine: "Calle Sol 3", ...PIN });
    check("P4 still one open request per relative (409)", second.status === 409, `${second.status}`);
    const mine = await call("GET", F, A.family.token);
    check("P5 the relative sees their own proposal with its point", mine.status === 200 && mine.body.requests?.[0]?.proposed_latitude === PIN.latitude, JSON.stringify(mine.body.requests?.[0] ?? {}).slice(0, 120));
    const famView = await call("GET", `/me/care-recipients/${rA}/service-location`, A.family.token);
    check("P6 the relative still never receives the official coordinates", famView.status === 200 && !("latitude" in (famView.body.location ?? {})) && !JSON.stringify(famView.body).includes("18.23"), JSON.stringify(famView.body).slice(0, 120));

    // ------------------------------------------------------------ I: isolation and roles
    const cross = await call("POST", `/me/care-recipients/${rA}/location-change-requests`, B.family.token, PIN);
    const notMine = await call("POST", `/me/care-recipients/${rA}/location-change-requests`, A.family2.token, PIN);
    const cgReq = await call("POST", `/me/care-recipients/${rA}/location-change-requests`, A.cg.token, PIN);
    check("I1 relatives of other people or agencies, and caregivers, cannot propose (404)", [cross, notMine, cgReq].every((r) => r.status === 404), [cross, notMine, cgReq].map((r) => r.status).join("/"));
    const famWrite = await call("PATCH", `${L}/service-locations/${locId}`, A.family.token, PIN);
    const famConfirm = await call("POST", `${L}/service-locations/${locId}/confirm-gps`, A.family.token, { ...PIN, confirm: true });
    check("I2 a relative can never write or confirm the official address directly (403)", famWrite.status === 403 && famConfirm.status === 403, `${famWrite.status}/${famConfirm.status}`);
    const bList = await call("GET", `${L}/location-change-requests`, B.admin.token);
    const bResolve = await call("POST", `${L}/location-change-requests/${onlyPin.body.request?.id}/resolve`, B.admin.token, { decision: "APPROVE" });
    check("I3 another agency neither sees nor resolves the proposal", bList.status === 403 && [403, 404].includes(bResolve.status), `${bList.status}/${bResolve.status}`);
    const direct = await (async () => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [A.family.userId, orgA]);
        await c.query(`UPDATE care_recipient_location_change_requests SET proposed_latitude = 18.3 WHERE requested_by_user_id = $1`, [A.family.userId]);
        return "allowed";
      } catch (e) { return (e as { code?: string }).code ?? "error"; } finally { await c.query("ROLLBACK").catch(() => undefined); await c.end(); }
    })();
    check("I4 at the database: the relative cannot change a proposed point afterwards (no UPDATE grant)", direct === "42501", direct);

    // ------------------------------------------------------------ R: agency review
    const list = await call("GET", `${L}/location-change-requests`, A.admin.token);
    const listed = (list.body.requests ?? []).find((r: Json) => r.id === onlyPin.body.request?.id);
    check("R1 the agency sees the proposed point to review it", list.status === 200 && listed?.proposed_latitude === PIN.latitude && listed?.proposed_longitude === PIN.longitude, JSON.stringify(listed ?? {}).slice(0, 140));
    const noConfirm = await call("POST", `${L}/location-change-requests/${onlyPin.body.request?.id}/resolve`, A.admin.token, { decision: "APPROVE", usePoint: true });
    check("R2 approving a new point with an upcoming shift needs explicit confirmation (409); nothing changes", noConfirm.status === 409 && noConfirm.body.error === "UPCOMING_SHIFTS_NEED_CONFIRMATION" && JSON.stringify(await primaryRow()) === JSON.stringify(before), `${noConfirm.status} ${noConfirm.body.error}`);
    const notifBefore = (await notices(A.cg, "SHIFT_LOCATION_CHANGED")).length;
    const ok = await call("POST", `${L}/location-change-requests/${onlyPin.body.request?.id}/resolve`, A.admin.token, { decision: "APPROVE", usePoint: true, confirmUpcomingShifts: true });
    const after = await primaryRow();
    check("R3 approved: the official point becomes the proposed one, UNCONFIRMED; the written address stays",
      ok.status === 200 && after.latitude === PIN.latitude && after.longitude === PIN.longitude && after.gps_confirmed_at === null && after.address_line === "Calle Luna 12",
      `${ok.status} ${JSON.stringify(after)}`);
    const cgLoc = await call("GET", `/organizations/${orgA}/shifts/${shiftId}/service-location`, A.cg.token);
    check("R4 the assigned caregiver is told the address changed and gets NO coordinates until a manager confirms the point",
      (await notices(A.cg, "SHIFT_LOCATION_CHANGED")).length === notifBefore + 1 && cgLoc.status === 200 && cgLoc.body.location?.latitude === null && cgLoc.body.location?.gpsConfirmed === false,
      `avisos=${(await notices(A.cg, "SHIFT_LOCATION_CHANGED")).length - notifBefore} lat=${cgLoc.body.location?.latitude}`);
    const events = (await q<{ event_type: string }>(`SELECT event_type FROM care_recipient_location_events WHERE location_id=$1 ORDER BY occurred_at`, [locId])).rows.map((r) => r.event_type);
    check("R5 the history keeps the change (GPS_CHANGED after GPS_CONFIRMED)", events.includes("GPS_CONFIRMED") && events.at(-1) === "GPS_CHANGED", events.join(","));
    const confirm = await call("POST", `${L}/service-locations/${locId}/confirm-gps`, A.admin.token, { ...PIN, confirm: true });
    const cgLoc2 = await call("GET", `/organizations/${orgA}/shifts/${shiftId}/service-location`, A.cg.token);
    check("R6 once the manager confirms it, the caregiver navigates to the exact point", confirm.status === 200 && cgLoc2.body.location?.latitude === PIN.latitude, `${confirm.status} lat=${cgLoc2.body.location?.latitude}`);

    // usePoint:false and reject leave the point untouched
    const p2 = await call("POST", F, A.family.token, { addressLine: "Calle Luna 12, Bo. Bairoa", latitude: 18.25, longitude: -66.05 });
    const keep = await call("POST", `${L}/location-change-requests/${p2.body.request?.id}/resolve`, A.admin.token, { decision: "APPROVE", usePoint: false, confirmUpcomingShifts: true });
    const kept = await primaryRow();
    // The street changed, so the existing rule (migration 105) asks to confirm the point again; the point itself stays.
    check("R7 approve with «usePoint:false»: the written correction applies and the proposed point is NOT used (coordinates unchanged; a new street asks to reconfirm the point, rule 105)",
      keep.status === 200 && kept.latitude === PIN.latitude && kept.longitude === PIN.longitude && kept.address_line === "Calle Luna 12, Bo. Bairoa" && kept.gps_confirmed_at === null, `${keep.status} ${JSON.stringify(kept)}`);
    await call("POST", `${L}/service-locations/${locId}/confirm-gps`, A.admin.token, { ...PIN, confirm: true });
    const beforeRej = await primaryRow();
    const p3 = await call("POST", F, A.family.token, { latitude: 18.26, longitude: -66.06 });
    const rej = await call("POST", `${L}/location-change-requests/${p3.body.request?.id}/resolve`, A.admin.token, { decision: "REJECT", note: "Ya está correcto" });
    const afterRej = await primaryRow();
    check("R8 rejected: nothing changes (same point, still confirmed)", rej.status === 200 && JSON.stringify(afterRej) === JSON.stringify(beforeRej) && !!afterRej.gps_confirmed_at, `${rej.status}`);
    // An older agency screen (before «Pegar ubicación») never sends usePoint: it cannot apply a PIN it never showed.
    const beforeLegacy = await primaryRow();
    const p5 = await call("POST", F, A.family.token, { accessNotes: "Portón verde", latitude: 18.27, longitude: -66.07 });
    const legacy = await call("POST", `${L}/location-change-requests/${p5.body.request?.id}/resolve`, A.admin.token, { decision: "APPROVE", confirmUpcomingShifts: true });
    const afterLegacy = await primaryRow();
    check("R10 approval from an older screen (no usePoint): the written part applies, the unseen PIN is NOT applied and the confirmed point stays",
      legacy.status === 200 && afterLegacy.latitude === beforeLegacy.latitude && afterLegacy.longitude === beforeLegacy.longitude && !!afterLegacy.gps_confirmed_at,
      `${legacy.status} ${JSON.stringify(afterLegacy)}`);
    const p4 = await call("POST", `/me/care-recipients/${rA2}/location-change-requests`, A.family2.token, { latitude: 18.2341, longitude: -66.0485 });
    const firstAddr = await call("POST", `/organizations/${orgA}/care-recipients/${rA2}/location-change-requests/${p4.body.request?.id}/resolve`, A.admin.token, { decision: "APPROVE", usePoint: true });
    const newPrimary = await primaryRow(rA2);
    check("R9 a person without an address yet: approving creates the primary with the point, unconfirmed",
      firstAddr.status === 200 && newPrimary?.latitude === PIN.latitude && newPrimary?.gps_confirmed_at === null, `${firstAddr.status} ${JSON.stringify(newPrimary)}`);

    // ------------------------------------------------------------ C: caregivers never see a proposed point
    const pend = await call("POST", F, A.family.token, { accessNotes: "Entrada por el lado", latitude: 18.28, longitude: -66.08 });
    const officialNow = await primaryRow();
    const cgList = await call("GET", `${L}/location-change-requests`, A.cg.token);
    const cgMine = await call("GET", F, A.cg.token);
    check("C1 a caregiver cannot list the relatives' requests (403) nor read them as their own (404/empty)",
      pend.status === 201 && cgList.status === 403 && (cgMine.status === 404 || (cgMine.status === 200 && (cgMine.body.requests ?? []).length === 0)), `${pend.status} ${cgList.status}/${cgMine.status}`);
    const cgShift = await call("GET", `/organizations/${orgA}/shifts/${shiftId}/service-location`, A.cg.token);
    check("C2 with a PIN proposal pending, the caregiver's shift shows only the official confirmed point",
      cgShift.status === 200 && cgShift.body.location?.latitude === officialNow.latitude && !JSON.stringify(cgShift.body).includes("18.28") && !JSON.stringify(cgShift.body).includes("proposed"),
      `${cgShift.status} lat=${cgShift.body.location?.latitude}`);
    const cgDb = await (async () => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [A.cg.userId, orgA]);
        return (await c.query(`SELECT proposed_latitude FROM care_recipient_location_change_requests`)).rowCount;
      } finally { await c.query("ROLLBACK").catch(() => undefined); await c.end(); }
    })();
    check("C3 at the database (RLS): a caregiver reads 0 proposals", cgDb === 0, `filas=${cgDb}`);
    const famOwn = await call("GET", `/me/care-recipients/${rA}/service-location`, A.family.token);
    check("C4 the relative sees their own proposal but still never the official coordinates", famOwn.status === 200 && !JSON.stringify(famOwn.body).includes(String(officialNow.latitude)), JSON.stringify(famOwn.body).slice(0, 80));

    // ------------------------------------------------------------ M: short-link resolver
    const M = "/maps/resolve-link";
    const noAuth = await call("POST", M, "", { url: "https://maps.app.goo.gl/AbC123xyz" });
    const badBody = await call("POST", M, A.admin.token, { link: "x" });
    check("M1 sign-in required (401) and a strict payload (400)", noAuth.status === 401 && badBody.status === 400, `${noAuth.status}/${badBody.status}`);
    const g = await call("POST", M, A.admin.token, { url: "https://maps.app.goo.gl/AbC123xyz" });
    const ap = await call("POST", M, A.family.token, { url: "https://maps.apple/p/Ab.Cd-12" });
    check("M2 Google and Apple short links expand to the point (agency and relative)",
      g.status === 200 && g.body.status === "point" && g.body.point?.latitude === PIN.latitude && ap.body.status === "point" && ap.body.point?.longitude === PIN.longitude,
      `${g.status} ${JSON.stringify(g.body)} ${JSON.stringify(ap.body)}`);
    const before3 = outgoing.length;
    const refused = await Promise.all(["https://evil.example.com/AbC123xyz", "https://www.google.com/maps?q=18.2,-66.0", "http://maps.app.goo.gl/AbC123xyz", "https://169.254.169.254/latest"].map((u) => call("POST", M, A.admin.token, { url: u })));
    check("M3 any other link is refused WITHOUT any outbound request", refused.every((r) => r.body.status === "unsupported") && outgoing.length === before3, `${refused.map((r) => r.body.status).join("/")} salidas=${outgoing.length - before3}`);
    const far = await call("POST", M, A.admin.token, { url: "https://maps.app.goo.gl/FueraDePR1" });
    check("M4 a destination outside Puerto Rico is refused", far.body.status === "outside-pr", far.body.status);
    check("M5 the answer never echoes the link", !JSON.stringify(g.body).includes("goo.gl") && !JSON.stringify(g.body).includes("google.com"), JSON.stringify(g.body));
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await call("POST", M, B.admin.token, { url: "https://maps.app.goo.gl/AbC123xyz" })).status === 429) limited++;
    check("M6 per-person limit: after 20 expansions in 10 minutes, 429", limited === 5, `429=${limited}`);
    check("M7 every outbound request went only to the providers' short-link hosts", outgoing.every((x) => x.startsWith("https://maps.app.goo.gl/") || x.startsWith("https://maps.apple/p/")), outgoing.filter((x) => !/maps\.app\.goo\.gl|maps\.apple\/p/.test(x)).join(","));

    // ------------------------------------------------------------ privacy of logs
    const leaked = logged.filter((l) => /18\.2341|-66\.0485|18\.2[5-8]\b|-66\.0[5-8]\b|Calle Luna|Port[oó]n|Entrada por|goo\.gl|maps\.apple|AbC123/.test(l));
    check("Z1 logs contain no address, coordinates or links", leaked.length === 0, `líneas=${leaked.length}`);
  } finally {
    server.close();
    await pool.end();
    await db.end();
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) out(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
  out(`\nLocation paste: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) { for (const r of failed) out(`::error title=verifyLocationPaste::${r.name} [${r.detail}]`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
