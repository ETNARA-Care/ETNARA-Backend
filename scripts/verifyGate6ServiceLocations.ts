/**
 * Gate 6: service location, shift address, caregiver navigation access,
 * arrival with consented proximity, late-arrival notices, family correction
 * requests and FILLED-opportunity cancellation -- over real HTTP with the
 * server connected as app_runtime, plus direct RLS probes. Synthetic data only.
 *
 * Disposable databases only:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");

// Family invitations arrive by e-mail (migration 120): an in-process fake provider keeps
// the message so FP6 can read the one-time link. Nothing is sent anywhere.
const familyInvitationMails: string[] = [];
const realFetchForMail = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    familyInvitationMails.push(String(JSON.parse(String(init?.body ?? "{}")).html ?? ""));
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetchForMail(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.ACTIVATION_BASE_URL = "https://app.example.invalid";
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

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
  const { notifyLateShiftArrivals, classifyProximity, distanceMeters } = await import("../src/modules/verification/verification.arrival.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  }
  const org = async (name: string) =>
    (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [name])).rows[0].id;
  const orgA = await org(`G6 A ${tag}`);
  const orgB = await org(`G6 B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'G6') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; workerId?: string; membershipId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `g6-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    if (roles.length) {
      const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    }
    let workerId: string | undefined; let membershipId: string | undefined;
    if (worker) {
      workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      membershipId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [membershipId, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [membershipId, orgId, d]);
    }
    return { email, userId, token: "", workerId, membershipId };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]),
    supervisor: await person("a-sup", orgA, ["SUPERVISOR"]),
    cg1: await person("a-cg1", orgA, ["WORKER"], true),
    cg2: await person("a-cg2", orgA, ["WORKER"], true),
    cg3: await person("a-cg3", orgA, ["WORKER"], true),
    family: await person("a-family", orgA, ["FAMILY"]),
    family2: await person("a-family2", orgA, ["FAMILY"]),
    platform: await person("platform", orgA, []),
    invitee: await person("a-invitee", orgA, []),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), family: await person("b-family", orgB, ["FAMILY"]) };
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [A.platform.userId]);
  const recipient = async (o: string, last: string, locationId: string | null = null) =>
    (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,location_id) VALUES ($1,'Sintetico',$2,$3) RETURNING id`, [o, `${last}-${tag}`, locationId])).rows[0].id;
  const rA = await recipient(orgA, "Casa");
  const rA2 = await recipient(orgA, "Otra");
  const establishment = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name,address) VALUES ($1,'Hogar Sintético','Calle Sintética 1, Cayey') RETURNING id`, [orgA])).rows[0].id;
  const rRes = await recipient(orgA, "Residente", establishment);
  const rB = await recipient(orgB, "B");
  const relA = (await q<{ id: string }>(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active') RETURNING id`, [A.family.userId, orgA, rA])).rows[0].id;
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'sobrino','active')`, [A.family2.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hijo','active')`, [B.family.userId, orgB, rB]);

  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), ...Object.values(B).map((p) => [p, orgB] as const)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== A.platform) await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  const runtime = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();
  async function asRuntime<T extends pg.QueryResultRow>(userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      return (await runtime.query<T>(text, params)).rows;
    } finally { await runtime.query("ROLLBACK"); }
  }
  const tryRuntime = async (userId: string, orgId: string, text: string, params: unknown[] = []) => {
    try { await asRuntime(userId, orgId, text, params); return null; } catch (e) { return e as Error; }
  };
  const L = `/organizations/${orgA}/care-recipients/${rA}`;
  const notices = async (p: P, type: string) => ((await call("GET", "/me/notifications?limit=100", p.token)).body.items ?? [] as Json[]).filter((n: Json) => n.type === type);
  const hasAddress = (v: unknown) => /Calle Luna|Calle Sol|Calle Mar|Calle Sintética|Parcela/i.test(JSON.stringify(v));
  const future = (days: number, hours = 4) => {
    const s = new Date(Date.now() + days * 86400e3); s.setUTCMinutes(0, 0, 0);
    return { scheduledStart: s.toISOString(), scheduledEnd: new Date(s.getTime() + hours * 3600e3).toISOString() };
  };
  /** Arrival tests: «Llegué» is only accepted from 2 h before the start (migration 107). */
  const soon = (id: string) => q(`UPDATE shifts SET scheduled_start = now() + interval '30 minutes', scheduled_end = now() + interval '4 hours' WHERE id = $1`, [id]);
  async function assignedShift(p: P, recipientId: string, days: number, extra: Json = {}) {
    const s = await call("POST", `/organizations/${orgA}/shifts`, A.admin.token, { careRecipientId: recipientId, ...future(days), ...extra });
    const id = s.body.shift?.id as string;
    await call("POST", `/organizations/${orgA}/shifts/${id}/assignments`, A.admin.token, { organizationWorkerMembershipId: p.membershipId });
    await call("POST", `/organizations/${orgA}/me/shifts/${id}/respond`, p.token, { decision: "accepted" });
    return { id, status: s.status, body: s.body };
  }

  try {
    // ================================================================ L: addresses
    const casa = { label: "Casa", addressLine: "Calle Luna 12, Urb. Sintética", municipality: "Caguas", postalCode: "00725",
      accessNotes: "Portón verde; estacionar frente.", latitude: 18.2341, longitude: -66.0485 };
    const c1 = await call("POST", `${L}/service-locations`, A.admin.token, casa);
    const primaryId = c1.body.location?.id as string;
    check("L1 admin registers the exact address (primary by default)", c1.status === 201 && c1.body.location?.isPrimary === true, `status=${c1.status}`);
    const badMuni = await call("POST", `${L}/service-locations`, A.admin.token, { ...casa, municipality: "Springfield" });
    const badZip = await call("POST", `${L}/service-locations`, A.admin.token, { ...casa, postalCode: "7250" });
    check("L2 municipality must be a Puerto Rico municipality; ZIP must be valid", badMuni.status === 400 && badZip.status === 400, `${badMuni.status},${badZip.status}`);
    const alt = await call("POST", `${L}/service-locations`, A.supervisor.token, { label: "Casa de la hija", addressLine: "Calle Sol 4", municipality: "Cidra", postalCode: "00739", latitude: 18.1755, longitude: -66.1612 });
    const altId = alt.body.location?.id as string;
    check("L3 supervisor adds an authorized alternate address (not primary)", alt.status === 201 && alt.body.location?.isPrimary === false, `status=${alt.status}`);
    const cgWrite = await call("POST", `${L}/service-locations`, A.cg1.token, casa);
    const famWrite = await call("POST", `${L}/service-locations`, A.family.token, casa);
    check("L4 caregiver and family cannot create addresses", cgWrite.status === 403 && [403, 404].includes(famWrite.status), `${cgWrite.status},${famWrite.status}`);
    const bList = await call("GET", `${L}/service-locations`, B.admin.token);
    const bCross = await call("GET", `/organizations/${orgB}/care-recipients/${rA}/service-locations`, B.admin.token);
    check("L5 agency B cannot list or reach agency A addresses", [403, 404].includes(bList.status) && bCross.status === 404, `${bList.status},${bCross.status}`);
    const verify = await call("POST", `${L}/service-locations/${primaryId}/verify`, A.admin.token);
    const edited = await call("PATCH", `${L}/service-locations/${primaryId}`, A.admin.token, { addressLine: "Calle Luna 12-A, Urb. Sintética" });
    check("L6 verify, then editing the address clears the verification", !!verify.body.location?.verifiedAt && edited.status === 200 && edited.body.location?.verifiedAt === null, `${verify.status},${edited.status}`);
    const hist = await call("GET", `${L}/service-locations/history`, A.admin.token);
    const kinds = ((hist.body.events ?? []) as Json[]).map((e) => e.event_type);
    const upd = ((hist.body.events ?? []) as Json[]).find((e) => e.event_type === "UPDATED");
    check("L7 auditable history: CREATED, VERIFIED, UPDATED with previous and new values",
      kinds.filter((k) => k === "CREATED").length === 2 && kinds.includes("VERIFIED") && upd?.previous?.address_line === casa.addressLine && upd?.current?.address_line?.endsWith("12-A, Urb. Sintética"), kinds.join(","));
    const histSup = await call("GET", `${L}/service-locations/history`, A.cg1.token);
    check("L8 history is for managers only", histSup.status === 403, `status=${histSup.status}`);
    const est = await call("POST", `/organizations/${orgA}/care-recipients/${rRes}/service-locations`, A.admin.token, { label: "Hogar", establishmentId: establishment });
    const estRow = (await q<{ address_line: string | null; establishment_id: string }>(`SELECT address_line, establishment_id FROM care_recipient_locations WHERE id=$1`, [est.body.location?.id ?? randomUUID()])).rows[0];
    check("L9 residential home: reuses the establishment address without copying it",
      est.status === 201 && est.body.location?.establishment?.address === "Calle Sintética 1, Cayey" && estRow?.address_line === null && estRow?.establishment_id === establishment, `status=${est.status}`);
    const estCopy = await call("POST", `/organizations/${orgA}/care-recipients/${rRes}/service-locations`, A.admin.token, { establishmentId: establishment, addressLine: "copia" });
    check("L10 establishment address cannot be duplicated into the record", estCopy.status === 400, `status=${estCopy.status}`);
    const archPrimary = await call("POST", `${L}/service-locations/${primaryId}/archive`, A.admin.token);
    check("L11 the primary address cannot be archived", archPrimary.status === 409 && archPrimary.body.error === "PRIMARY_CANNOT_BE_ARCHIVED", `status=${archPrimary.status}`);
    let twoPrimaries = false;
    try { await q(`INSERT INTO care_recipient_locations (care_recipient_id,organization_id,address_line,is_primary) VALUES ($1,$2,'x',true)`, [rA, orgA]); }
    catch (e) { twoPrimaries = (e as { code?: string }).code === "23505"; }
    check("L12 database allows only one primary address per person", twoPrimaries);
    const legacy = await call("GET", `${L}/location`, A.admin.token);
    check("L13 Phase 12.1 endpoint keeps working on the primary address", legacy.status === 200 && legacy.body.location?.address_line?.startsWith("Calle Luna 12-A"), `status=${legacy.status}`);
    const crossOrg = await tryRuntime(B.admin.userId, orgB, `INSERT INTO care_recipient_locations (care_recipient_id,organization_id,address_line) VALUES ($1,$2,'x')`, [rA, orgB]);
    check("L14 an address can never be attached to another agency's person", crossOrg !== null);

    // ================================================================ S: shift address
    const s1 = await assignedShift(A.cg1, rA, 3);
    const s1Loc = (await q<{ service_location_id: string | null }>(`SELECT service_location_id FROM shifts WHERE id=$1`, [s1.id])).rows[0]?.service_location_id;
    check("S1 a new shift keeps a reference to the confirmed (primary) address", s1.status === 201 && s1Loc === primaryId, `status=${s1.status}`);
    const s2 = await assignedShift(A.cg2, rA, 4, { serviceLocationId: altId });
    const s2Loc = (await q<{ service_location_id: string | null }>(`SELECT service_location_id FROM shifts WHERE id=$1`, [s2.id])).rows[0]?.service_location_id;
    check("S2 the admin can confirm an alternate address for a shift", s2.status === 201 && s2Loc === altId, `status=${s2.status}`);
    const wrong = await call("POST", `/organizations/${orgA}/shifts`, A.admin.token, { careRecipientId: rA2, ...future(5), serviceLocationId: altId });
    check("S3 an address of another person is refused", wrong.status === 400 && wrong.body.error === "SERVICE_LOCATION_NOT_IN_RECIPIENT", `status=${wrong.status}`);
    let mismatch = false;
    try { await q(`UPDATE shifts SET service_location_id=$1 WHERE id=$2`, [est.body.location?.id, s1.id]); }
    catch (e) { mismatch = /SHIFT_SERVICE_LOCATION_MISMATCH/.test((e as Error).message); }
    check("S4 database rejects a shift address that is not the person's, even for a superuser", mismatch);
    const options = await call("GET", `${L}/service-location-options`, A.admin.token);
    check("S5 the shift form gets the person's active addresses to choose from", (options.body.options ?? []).length === 2 && options.body.options[0].isPrimary, `n=${(options.body.options ?? []).length}`);

    // ================================================================ C: caregiver access
    const nav = await call("GET", `/organizations/${orgA}/shifts/${s2.id}/service-location`, A.cg2.token);
    check("C1 assigned caregiver gets her shift's address; an unconfirmed marker is NOT handed out (approximate navigation)",
      nav.status === 200 && nav.body.location?.id === altId && nav.body.location?.latitude === null && nav.body.location?.gpsConfirmed === false
      && nav.body.location?.addressLine === "Calle Sol 4", `status=${nav.status}`);

    // ================================================================ G: address verified vs GPS confirmed (Gate 6 fixes)
    const altRow = (await call("GET", `${L}/service-locations`, A.admin.token)).body.locations?.find((l: Json) => l.id === altId);
    check("G1 a marker placed in the form is not a GPS confirmation", altRow?.latitude === 18.1755 && altRow?.gpsConfirmedAt === null);
    await call("POST", `${L}/service-locations/${altId}/verify`, A.admin.token);
    const verifiedOnly = (await call("GET", `${L}/service-locations`, A.admin.token)).body.locations?.find((l: Json) => l.id === altId);
    check("G2 verifying the written address does not confirm the GPS point", !!verifiedOnly?.verifiedAt && verifiedOnly?.gpsConfirmedAt === null);
    const GPS = `${L}/service-locations/${altId}/confirm-gps`;
    const noConfirm = await call("POST", GPS, A.admin.token, { latitude: 18.1756, longitude: -66.1613 });
    const outside = await call("POST", GPS, A.admin.token, { latitude: 40.71, longitude: -74.0, confirm: true });
    check("G3 confirmation must be explicit and inside Puerto Rico", noConfirm.status === 400 && outside.status === 400, `${noConfirm.status},${outside.status}`);
    const cgGps = await call("POST", GPS, A.cg2.token, { latitude: 18.1756, longitude: -66.1613, confirm: true });
    const famGps = await call("POST", GPS, A.family.token, { latitude: 18.1756, longitude: -66.1613, confirm: true });
    const bGps = await call("POST", `/organizations/${orgB}/care-recipients/${rA}/service-locations/${altId}/confirm-gps`, B.admin.token, { latitude: 18.1756, longitude: -66.1613, confirm: true });
    check("G4 caregiver, family and another agency cannot confirm coordinates", cgGps.status === 403 && [403, 404].includes(famGps.status) && bGps.status === 404, `${cgGps.status},${famGps.status},${bGps.status}`);
    const confirmed = await call("POST", GPS, A.supervisor.token, { latitude: 18.1756, longitude: -66.1613, confirm: true });
    const histGps = ((await call("GET", `${L}/service-locations/history`, A.admin.token)).body.events ?? [] as Json[]).find((e: Json) => e.event_type === "GPS_CONFIRMED" && e.location_id === altId);
    check("G5 a manager confirms the exact point; who and when are recorded",
      confirmed.status === 200 && !!confirmed.body.location?.gpsConfirmedAt && histGps?.actor_user_id === A.supervisor.userId && confirmed.body.location?.verifiedAt !== null, `status=${confirmed.status}`);
    const nav2 = await call("GET", `/organizations/${orgA}/shifts/${s2.id}/service-location`, A.cg2.token);
    check("G6 navigation then uses the confirmed coordinates", nav2.body.location?.gpsConfirmed === true && nav2.body.location?.latitude === 18.1756 && nav2.body.location?.longitude === -66.1613);
    const moved2 = await call("PATCH", `${L}/service-locations/${altId}`, A.admin.token, { latitude: 18.1760, longitude: -66.1620 });
    const histMove = ((await call("GET", `${L}/service-locations/history`, A.admin.token)).body.events ?? [] as Json[]).find((e: Json) => e.event_type === "GPS_CHANGED" && e.location_id === altId);
    check("G7 moving the marker clears the GPS confirmation, keeps the written-address verification, and is in the history",
      moved2.body.location?.gpsConfirmedAt === null && !!moved2.body.location?.verifiedAt && !!histMove, JSON.stringify({ g: moved2.body.location?.gpsConfirmedAt, v: !!moved2.body.location?.verifiedAt, h: !!histMove }));
    await call("POST", GPS, A.admin.token, { latitude: 18.1760, longitude: -66.1620, confirm: true });
    await call("POST", `${L}/service-locations/${altId}/verify`, A.admin.token);
    const zipOnly = await call("PATCH", `${L}/service-locations/${altId}`, A.admin.token, { postalCode: "00736", accessNotes: "Portón verde" });
    check("G8 a ZIP / access-notes edit clears only the address verification, not the confirmed point",
      zipOnly.body.location?.verifiedAt === null && !!zipOnly.body.location?.gpsConfirmedAt, JSON.stringify({ v: zipOnly.body.location?.verifiedAt, g: zipOnly.body.location?.gpsConfirmedAt }));
    const rewritten = await call("PATCH", `${L}/service-locations/${altId}`, A.admin.token, { addressLine: "Calle Sol 4-B" });
    check("G8b a new street clears the GPS confirmation too (the old point may be another house); marker kept as reference",
      rewritten.body.location?.verifiedAt === null && rewritten.body.location?.gpsConfirmedAt === null && rewritten.body.location?.latitude === 18.176,
      JSON.stringify({ g: rewritten.body.location?.gpsConfirmedAt, lat: rewritten.body.location?.latitude }));
    await call("POST", GPS, A.admin.token, { latitude: 18.1760, longitude: -66.1620, confirm: true });
    let noCoords = false;
    try { await q(`UPDATE care_recipient_locations SET latitude=NULL, longitude=NULL, gps_confirmed_at=now(), gps_confirmed_by_user_id=$2 WHERE id=$1`, [altId, A.admin.userId]); }
    catch (e) { noCoords = (e as { code?: string }).code === "23514"; }
    check("G9 database: a GPS confirmation without coordinates is impossible", noCoords);
    const opts2 = ((await call("GET", `${L}/service-location-options`, A.admin.token)).body.options ?? []) as Json[];
    check("G10 the shift form knows which addresses have a confirmed GPS point",
      opts2.find((o) => o.id === altId)?.gpsConfirmed === true && opts2.find((o) => o.id === primaryId)?.gpsConfirmed === false);
    const legacyId = (await q<{ id: string }>(`INSERT INTO care_recipient_locations (care_recipient_id,organization_id,address_line,municipality,latitude,longitude,is_primary,verified_at,verified_by_user_id)
      VALUES ($1,$2,'Calle Vieja 1','Cayey',18.11,-66.16,false,now(),$3) RETURNING id`, [rRes, orgA, A.admin.userId])).rows[0]?.id;
    const legacy2 = ((await call("GET", `/organizations/${orgA}/care-recipients/${rRes}/service-locations`, A.admin.token)).body.locations ?? []).find((l: Json) => l.id === legacyId);
    check("G11 existing verified addresses stay verified and are shown as 'GPS not confirmed'", !!legacy2?.verifiedAt && legacy2?.gpsConfirmedAt === null);
    const otherAddr = await asRuntime(A.cg2.userId, orgA, `SELECT id FROM care_recipient_locations WHERE id=$1`, [primaryId]);
    check("C2 she cannot read the person's other addresses (RLS)", otherAddr.length === 0, `rows=${otherAddr.length}`);
    const notAssigned = await call("GET", `/organizations/${orgA}/shifts/${s2.id}/service-location`, A.cg1.token);
    const famNav = await call("GET", `/organizations/${orgA}/shifts/${s2.id}/service-location`, A.family.token);
    check("C3 unassigned caregiver and family get nothing", notAssigned.status === 404 && famNav.status === 404, `${notAssigned.status},${famNav.status}`);
    const logged = await call("GET", `${L}/service-locations/history`, A.admin.token);
    check("C4 caregiver access to the address is logged for the agency",
      ((logged.body.access ?? []) as Json[]).some((a) => a.user_id === A.cg2.userId && a.shift_id === s2.id && a.location_id === altId));
    const s3 = await assignedShift(A.cg3, rA, 6);
    await call("POST", `/organizations/${orgA}/shifts/${s3.id}/cancel`, A.admin.token, {});
    const afterCancel = await call("GET", `/organizations/${orgA}/shifts/${s3.id}/service-location`, A.cg3.token);
    const rlsCancel = await asRuntime(A.cg3.userId, orgA, `SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1`, [rA]);
    check("C5 access ends when the shift is cancelled (API and RLS)", afterCancel.status === 404 && rlsCancel.length === 0, `${afterCancel.status},${rlsCancel.length}`);

    // ================================================================ M: change of address with upcoming shifts
    const moved = await call("POST", `${L}/service-locations`, A.admin.token, { label: "Nueva casa", addressLine: "Calle Mar 8", municipality: "Caguas", postalCode: "00725", latitude: 18.2401, longitude: -66.0331, makePrimary: true });
    const newPrimary = moved.body.location?.id as string;
    const stillOld = (await q<{ service_location_id: string }>(`SELECT service_location_id FROM shifts WHERE id=$1`, [s1.id])).rows[0].service_location_id;
    check("M1 a new primary address warns about upcoming shifts and does NOT move them by itself",
      moved.status === 201 && (moved.body.shiftsOnOtherAddresses ?? []).includes(s1.id) && stillOld === primaryId, `status=${moved.status}`);
    const cgMove = await call("POST", `${L}/service-locations/reassign-shifts`, A.cg1.token, { shiftIds: [s1.id], toLocationId: newPrimary });
    const bMove = await call("POST", `/organizations/${orgB}/care-recipients/${rA}/service-locations/reassign-shifts`, B.admin.token, { shiftIds: [s1.id], toLocationId: newPrimary });
    check("M2 only the agency's managers can move shifts to the new address", cgMove.status === 403 && [403, 404].includes(bMove.status), `${cgMove.status},${bMove.status}`);
    const move = await call("POST", `${L}/service-locations/reassign-shifts`, A.admin.token, { shiftIds: [s1.id], toLocationId: newPrimary });
    const audit = (await q<{ previous_location_id: string; new_location_id: string; changed_by_user_id: string }>(`SELECT previous_location_id,new_location_id,changed_by_user_id FROM shift_service_location_changes WHERE shift_id=$1`, [s1.id])).rows;
    check("M3 explicit update of affected shifts is audited (who, from, to)",
      move.status === 200 && (move.body.movedShiftIds ?? []).includes(s1.id) && audit.length === 1 && audit[0].previous_location_id === primaryId
      && audit[0].new_location_id === newPrimary && audit[0].changed_by_user_id === A.admin.userId, `status=${move.status}`);
    const changedNotice = await notices(A.cg1, "SHIFT_LOCATION_CHANGED");
    check("M4 the assigned caregiver is told the address changed (no address in the notice)", changedNotice.length === 1 && !hasAddress(changedNotice), `n=${changedNotice.length}`);
    const archInUse = await call("POST", `${L}/service-locations/${altId}/archive`, A.admin.token);
    check("M5 an address used by an upcoming shift cannot be archived", archInUse.status === 409 && archInUse.body.error === "LOCATION_IN_USE_BY_UPCOMING_SHIFTS", `status=${archInUse.status}`);

    // ================================================================ F: family
    const f0 = await call("GET", `/me/care-recipients/${rA}/service-location`, A.family.token);
    const f0rls = await asRuntime(A.family.userId, orgA, `SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1`, [rA]);
    check("F1 family sees no address until the agency allows it (API and RLS)", f0.status === 200 && f0.body.canView === false && f0.body.location === null && f0rls.length === 0, `status=${f0.status}`);
    const touched = async (userId: string, sqlText: string, params: unknown[]) => {
      try { return (await asRuntime(userId, orgA, sqlText + " RETURNING 1", params)).length; } catch { return -1; }
    };
    const relRow = async (id: string) => (await q<Json>(`SELECT * FROM family_relationships WHERE id=$1`, [id])).rows[0];
    const selfGrant = await touched(A.family.userId, `UPDATE family_relationships SET can_view_service_location=true WHERE id=$1`, [relA]);
    check("F2 a relative cannot grant the permission to themself", selfGrant <= 0, `touched=${selfGrant}`);

    // ================================================================ P: family permissions (migration 104)
    const flagWrites = [
      await touched(A.family.userId, `UPDATE family_relationships SET can_view_photos = NOT can_view_photos WHERE id=$1`, [relA]),
      await touched(A.family.userId, `UPDATE family_relationships SET can_participate_in_verification = true WHERE id=$1`, [relA]),
      await touched(A.family.userId, `UPDATE family_relationships SET is_primary_contact = true WHERE id=$1`, [relA]),
    ];
    check("FP1 a relative cannot change their own can_view_photos / can_participate_in_verification / primary contact",
      flagWrites.every((n) => n <= 0), `touched=${flagWrites.join(",")}`);
    const repoint = await touched(A.family.userId, `UPDATE family_relationships SET care_recipient_id=$2 WHERE id=$1`, [relA, rA2]);
    const selfInsert = await touched(A.family.userId,
      `INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [A.family.userId, orgA, rA2]);
    check("FP2 a relative cannot re-point their relationship nor add one to another person", repoint <= 0 && selfInsert <= 0, `${repoint},${selfInsert}`);
    const rel2 = (await q<{ id: string }>(`SELECT id FROM family_relationships WHERE user_id=$1 AND care_recipient_id=$2`, [A.family2.userId, rA])).rows[0].id;
    const dbRevoke = await touched(A.family.userId, `UPDATE family_relationships SET status='revoked', revoked_at=now() WHERE id=$1`, [rel2]);
    const dbDelete = await touched(A.cg1.userId, `DELETE FROM family_relationships WHERE id=$1`, [rel2]);
    const revokeUrl = `${L}/family/${rel2}/revoke`;
    const revFam = await call("POST", revokeUrl, A.family.token);
    const revCg = await call("POST", revokeUrl, A.cg1.token);
    const rel2Row = await relRow(rel2);
    check("FP3 relatives and caregivers cannot revoke or delete another family's access (DB and HTTP)",
      dbRevoke <= 0 && dbDelete <= 0 && rel2Row?.status === "active" && revFam.status === 403 && revCg.status === 403, `${dbRevoke},${dbDelete},${revFam.status},${revCg.status}`);
    const famRead = await asRuntime(A.family.userId, orgA, `SELECT id FROM family_relationships WHERE id=$1`, [relA]);
    check("FP4 reads unchanged: the relative still sees their own relationship", famRead.length === 1);
    // Policy self-insert path (legacy family_invitations): only with a valid pending invitation, defaults only.
    const legacyInv = await call("POST", `/organizations/${orgA}/care-recipients/${rA2}/family-invitations`, A.admin.token,
      { email: A.invitee.email, relationshipType: "nieta", canViewPhotos: false });
    const invId = legacyInv.body.invitation?.id as string | undefined;
    await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active')`, [A.invitee.userId, orgA]);
    const ins = (extra: string, vals: string) => tryRuntime(A.invitee.userId, orgA,
      `INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,invitation_id,relationship_type,can_view_photos,status${extra})
       VALUES ($1,$2,$3,$4,'nieta',${vals},'active'${extra ? ",true" : ""})`, [A.invitee.userId, orgA, rA2, invId]);
    const tampered = await ins(",can_participate_in_verification", "false");
    const wrongPhoto = await ins("", "true");
    const exact = await ins("", "false");  // succeeds (rolled back by asRuntime)
    await q(`DELETE FROM organization_memberships WHERE user_id=$1 AND organization_id=$2`, [A.invitee.userId, orgA]);
    check("FP5 relatives never self-insert, not even with a valid invitation (agency or secure activation only, 107)",
      legacyInv.status === 201 && tampered !== null && wrongPhoto !== null && exact !== null,
      `${legacyInv.status},${tampered ? "refused" : "allowed"},${wrongPhoto ? "refused" : "allowed"},${exact?.message.slice(0, 40) ?? "ok"}`);
    // Product path: secure access invitation (SECURITY DEFINER activation) still links the relative.
    const accInv = await call("POST", `/organizations/${orgA}/access-invitations`, A.admin.token,
      { type: "family", email: A.invitee.email, careRecipientId: rA2, relationshipType: "nieta" });
    const mailedToken = /\/activate#token=([0-9a-f]{64})/.exec(familyInvitationMails.at(-1) ?? "")?.[1] ?? "";
    const accepted = await call("POST", "/access-invitations/accept", A.invitee.token, { token: mailedToken });
    const newRow = (await q<Json>(`SELECT * FROM family_relationships WHERE user_id=$1 AND care_recipient_id=$2`, [A.invitee.userId, rA2])).rows[0];
    check("FP6 an invited relative still activates access through the secure invitation (default permissions)",
      accInv.status === 201 && accepted.status === 200 && newRow?.status === "active" && newRow?.can_participate_in_verification === false,
      `${accInv.status},${accepted.status} ${accepted.body.error ?? ""}`);
    const revSup = newRow ? await call("POST", `/organizations/${orgA}/care-recipients/${rA2}/family/${newRow.id}/revoke`, A.supervisor.token) : { status: 0 };
    check("FP7 an agency manager still revokes family access", revSup.status === 200 && (newRow ? (await relRow(newRow.id)).status === "revoked" : false), `status=${revSup.status}`);
    const grant = await call("PUT", `${L}/family-location-permissions/${relA}`, A.admin.token, { canViewServiceLocation: true });
    const f1 = await call("GET", `/me/care-recipients/${rA}/service-location`, A.family.token);
    check("F3 with permission: primary address only, without coordinates or access notes",
      grant.status === 200 && f1.body.canView === true && f1.body.location?.addressLine === "Calle Mar 8" && !("latitude" in (f1.body.location ?? {})) && !("accessNotes" in (f1.body.location ?? {})), `status=${f1.status}`);
    const f2 = await call("GET", `/me/care-recipients/${rA}/service-location`, A.family2.token);
    check("F4 a relative without the permission still sees nothing", f2.body.canView === false && f2.body.location === null);
    const fb = await call("GET", `/me/care-recipients/${rA}/service-location`, B.family.token);
    check("F5 a family member of another agency's person gets nothing", fb.status === 404, `status=${fb.status}`);
    const req1 = await call("POST", `/me/care-recipients/${rA}/location-change-requests`, A.family2.token, { addressLine: "Calle Mar 8, Apto 2", message: "Falta el apartamento" });
    const req1b = await call("POST", `/me/care-recipients/${rA}/location-change-requests`, A.family2.token, { message: "otra" });
    check("F6 any active relative can request a correction; one open request at a time", req1.status === 201 && req1b.status === 409, `${req1.status},${req1b.status}`);
    const reqNotice = await notices(A.admin, "LOCATION_CHANGE_REQUESTED");
    check("F7 managers are notified of the request, without the address", reqNotice.length === 1 && !hasAddress(reqNotice), `n=${reqNotice.length}`);
    const famReadOthers = await asRuntime(A.family.userId, orgA, `SELECT id FROM care_recipient_location_change_requests WHERE id=$1`, [req1.body.request?.id]);
    const famUpdate = await asRuntime(A.family2.userId, orgA, `UPDATE care_recipient_location_change_requests SET status='APPROVED' WHERE id=$1 RETURNING id`, [req1.body.request?.id]).catch((e) => e as Error);
    check("F8 relatives cannot read others' requests nor approve their own", famReadOthers.length === 0 && (famUpdate instanceof Error || (famUpdate as unknown[]).length === 0));
    const rej = await call("POST", `${L}/location-change-requests/${req1.body.request?.id}/resolve`, A.admin.token, { decision: "REJECT", note: "Confirmado por teléfono: no hay apartamento" });
    const rejAgain = await call("POST", `${L}/location-change-requests/${req1.body.request?.id}/resolve`, A.admin.token, { decision: "APPROVE" });
    const famReqs = await call("GET", `/me/care-recipients/${rA}/location-change-requests`, A.family2.token);
    const rejNotice = await notices(A.family2, "LOCATION_CHANGE_REJECTED");
    check("F9 admin rejects with a note; relative sees the status and is notified; cannot be resolved twice",
      rej.status === 200 && rejAgain.status === 409 && famReqs.body.requests?.[0]?.status === "REJECTED" && rejNotice.length === 1, `${rej.status},${rejAgain.status}`);
    const req2 = await call("POST", `/me/care-recipients/${rA}/location-change-requests`, A.family.token, { postalCode: "00726", accessNotes: "Timbre al lado del portón" });
    const shiftsBefore = (await q<{ id: string; service_location_id: string | null }>(`SELECT id, service_location_id FROM shifts WHERE care_recipient_id=$1 ORDER BY id`, [rA])).rows;
    const cgNoticesBefore = (await notices(A.cg1, "SHIFT_LOCATION_CHANGED")).length + (await notices(A.cg2, "SHIFT_LOCATION_CHANGED")).length;
    const apprNoAck = await call("POST", `${L}/location-change-requests/${req2.body.request?.id}/resolve`, A.admin.token, { decision: "APPROVE" });
    const stillPending = (await q<{ status: string }>(`SELECT status FROM care_recipient_location_change_requests WHERE id=$1`, [req2.body.request?.id])).rows[0];
    check("F10 approving a change that affects upcoming shifts needs the agency's explicit confirmation",
      apprNoAck.status === 409 && apprNoAck.body.error === "UPCOMING_SHIFTS_NEED_CONFIRMATION" && stillPending.status === "PENDING", `status=${apprNoAck.status}`);
    const appr = await call("POST", `${L}/location-change-requests/${req2.body.request?.id}/resolve`, A.admin.token, { decision: "APPROVE", confirmUpcomingShifts: true });
    const after = (await q<{ postal_code: string; access_notes: string }>(`SELECT postal_code, access_notes FROM care_recipient_locations WHERE id=$1`, [newPrimary])).rows[0];
    const apprNotice = await notices(A.family, "LOCATION_CHANGE_APPROVED");
    check("F10b with confirmation: correction applied to the official address and the relative notified",
      appr.status === 200 && after.postal_code === "00726" && after.access_notes === "Timbre al lado del portón" && apprNotice.length === 1, `status=${appr.status}`);
    const shiftsAfter = (await q<{ id: string; service_location_id: string | null }>(`SELECT id, service_location_id FROM shifts WHERE care_recipient_id=$1 ORDER BY id`, [rA])).rows;
    const cgNoticesAfter = (await notices(A.cg1, "SHIFT_LOCATION_CHANGED")).length + (await notices(A.cg2, "SHIFT_LOCATION_CHANGED")).length;
    check("F10c shifts are not rewritten; their caregivers are told the address changed (no address in the notice)",
      JSON.stringify(shiftsAfter) === JSON.stringify(shiftsBefore) && appr.body.upcomingShiftsUpdated > 0 && cgNoticesAfter > cgNoticesBefore,
      `updated=${appr.body.upcomingShiftsUpdated} notices ${cgNoticesBefore}->${cgNoticesAfter}`);
    const histAppr = ((await call("GET", `${L}/service-locations/history`, A.admin.token)).body.events ?? [] as Json[])
      .filter((e: Json) => e.location_id === newPrimary && e.event_type === "UPDATED" && e.actor_user_id === A.admin.userId);
    const famReqsAfter = await call("GET", `/me/care-recipients/${rA}/location-change-requests`, A.family.token);
    check("F10d history kept: the change is in the address history (by the admin) and the relative sees «APPROVED»",
      histAppr.length > 0 && famReqsAfter.body.requests?.some((r: Json) => r.id === req2.body.request?.id && r.status === "APPROVED"), `events=${histAppr.length}`);
    const famPut = await call("PUT", `${L}/location`, A.family.token, { addressLine: "x" });
    check("F11 the family never edits the official address directly", [403, 404].includes(famPut.status), `status=${famPut.status}`);

    // ================================================================ A: arrival and proximity
    const sA = await assignedShift(A.cg1, rA2, 2);
    await soon(sA.id);
    await q(`INSERT INTO care_recipient_locations (care_recipient_id,organization_id,address_line,municipality,latitude,longitude) VALUES ($1,$2,'Parcela 3','Cayey',18.1100,-66.1660)`, [rA2, orgA]);
    const rA2Loc = (await q<{ id: string }>(`SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1`, [rA2])).rows[0].id;
    await q(`UPDATE shifts SET service_location_id=(SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1) WHERE id=$2`, [rA2, sA.id]);
    const ARR = (id: string) => `/organizations/${orgA}/shifts/${id}/arrival`;
    const noConsentCoords = await call("POST", ARR(sA.id), A.cg1.token, { latitude: 18.11, longitude: -66.166 });
    const storedAfterRefusal = (await q(`SELECT 1 FROM shift_arrivals WHERE shift_id=$1`, [sA.id])).rowCount;
    check("A1 without consent a location reading is refused and nothing is stored", noConsentCoords.status === 400 && noConsentCoords.body.error === "LOCATION_CONSENT_REQUIRED" && storedAfterRefusal === 0, `status=${noConsentCoords.status}`);
    const noConsent = await call("POST", ARR(sA.id), A.cg1.token, {});
    check("A2 without consent the arrival is still recorded, flagged for review (never blocked)",
      noConsent.status === 201 && noConsent.body.arrival?.proximity === "NO_CONSENT" && noConsent.body.arrival?.needsReview === true, `status=${noConsent.status}`);
    const reviewNotice = await notices(A.admin, "SHIFT_ARRIVAL_NEEDS_REVIEW");
    check("A3 the agency is notified that an arrival needs review (no address, no patient)", reviewNotice.length === 1 && reviewNotice[0].careRecipientId === null && !hasAddress(reviewNotice), `n=${reviewNotice.length}`);
    const dup = await call("POST", ARR(sA.id), A.cg1.token, {});
    check("A4 a second arrival for the same shift is refused", dup.status === 409 && dup.body.error === "ALREADY_ARRIVED", `status=${dup.status}`);
    const consent = await call("POST", `/organizations/${orgA}/me/location-consent`, A.cg1.token, { consentVersion: "location-check-v1" });
    const consentRow = (await q<{ consent_version: string }>(`SELECT consent_version FROM worker_location_consents WHERE user_id=$1 AND revoked_at IS NULL`, [A.cg1.userId])).rows;
    check("A5 separate, versioned consent for location checks is recorded", consent.status === 201 && consentRow[0]?.consent_version === "location-check-v1", `status=${consent.status}`);
    const sUnconf = await assignedShift(A.cg1, rA2, 11);
    await soon(sUnconf.id);
    await q(`UPDATE shifts SET service_location_id=$1 WHERE id=$2`, [rA2Loc, sUnconf.id]);
    const unconf = await call("POST", ARR(sUnconf.id), A.cg1.token, { latitude: 18.1105, longitude: -66.1655, accuracyM: 12 });
    check("G12 proximity is only compared with a confirmed GPS point (unconfirmed marker: NO_REFERENCE, no false alarm)",
      unconf.status === 201 && unconf.body.arrival?.proximity === "NO_REFERENCE" && unconf.body.arrival?.needsReview === false, JSON.stringify(unconf.body.arrival ?? unconf.body));
    await call("POST", `/organizations/${orgA}/care-recipients/${rA2}/service-locations/${rA2Loc}/confirm-gps`, A.admin.token, { latitude: 18.11, longitude: -66.166, confirm: true });
    const sNear = await assignedShift(A.cg1, rA2, 7);
    await soon(sNear.id);
    await q(`UPDATE shifts SET service_location_id=(SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1) WHERE id=$2`, [rA2, sNear.id]);
    const near = await call("POST", ARR(sNear.id), A.cg1.token, { latitude: 18.1105, longitude: -66.1655, accuracyM: 12 });
    check("A6 one reading near the address: NEAR, rounded distance, no review",
      near.status === 201 && near.body.arrival?.proximity === "NEAR" && near.body.arrival?.distanceM % 10 === 0 && near.body.arrival?.needsReview === false, JSON.stringify(near.body.arrival ?? near.body));
    const sFar = await assignedShift(A.cg1, rA2, 8);
    await soon(sFar.id);
    await q(`UPDATE shifts SET service_location_id=(SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1) WHERE id=$2`, [rA2, sFar.id]);
    const far = await call("POST", ARR(sFar.id), A.cg1.token, { latitude: 18.2341, longitude: -66.0485, accuracyM: 20 });
    check("A7 a reading far from the address: FAR, flagged for review, not blocked", far.status === 201 && far.body.arrival?.proximity === "FAR" && far.body.arrival?.needsReview === true, JSON.stringify(far.body.arrival ?? far.body));
    const sGps = await assignedShift(A.cg1, rA2, 9);
    await soon(sGps.id);
    const gps = await call("POST", ARR(sGps.id), A.cg1.token, {});
    check("A8 consent but GPS unavailable: UNAVAILABLE, review path", gps.status === 201 && gps.body.arrival?.proximity === "UNAVAILABLE" && gps.body.arrival?.needsReview === true, `status=${gps.status}`);
    const cols = (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='shift_arrivals'`)).rows.map((r) => r.column_name);
    const checkIn = await call("POST", `/organizations/${orgA}/shifts/${sFar.id}/check-in`, A.cg1.token, { verificationMethodCode: "CAREGIVER_SESSION", locationLat: 18.5, locationLng: -66.1 });
    const rawCoords = (await q<{ location_lat: string | null }>(`SELECT location_lat FROM verification_events WHERE shift_id=$1`, [sFar.id])).rows[0];
    check("A9 coordinates are never stored (no columns; check-in ignores sent coordinates)",
      !cols.some((c) => /lat|lng|lon/.test(c)) && checkIn.status === 201 && rawCoords?.location_lat === null, `check-in=${checkIn.status}`);
    const afterCheckIn = await call("POST", ARR(sFar.id), A.cg1.token, {});
    check("A10 a FAR arrival does not block the start; arrival after check-in is refused", afterCheckIn.status === 409, `status=${afterCheckIn.status}`);
    const vv = await call("GET", `/organizations/${orgA}/shifts/${sFar.id}/visit-verification`, A.admin.token);
    const arrival = (vv.body.arrivals ?? [])[0];
    check("A11 the agency sees real times: arrival result and the check-in", arrival?.proximity === "FAR" && !!arrival?.occurredAt && (vv.body.events ?? []).some((e: Json) => e.eventType === "check_in"), JSON.stringify(arrival ?? null).slice(0, 80));
    const cgReview = await call("POST", `${ARR(sFar.id)}/review`, A.cg1.token, { membershipId: A.cg1.membershipId, note: "yo" });
    const review = await call("POST", `${ARR(sFar.id)}/review`, A.supervisor.token, { membershipId: A.cg1.membershipId, note: "Llamada: estaba en la entrada del residencial" });
    const review2 = await call("POST", `${ARR(sFar.id)}/review`, A.admin.token, { membershipId: A.cg1.membershipId, note: "otra" });
    check("A12 administrative review: managers only, once, with a note", cgReview.status === 403 && review.status === 200 && review2.status === 409, `${cgReview.status},${review.status},${review2.status}`);
    const bArr = await asRuntime(B.admin.userId, orgB, `SELECT id FROM shift_arrivals`);
    const cg2Arr = await asRuntime(A.cg2.userId, orgA, `SELECT id FROM shift_arrivals WHERE shift_id=$1`, [sFar.id]);
    check("A13 arrivals are isolated: other agency and other caregivers see none", bArr.length === 0 && cg2Arr.length === 0);
    await call("DELETE", `/organizations/${orgA}/me/location-consent`, A.cg1.token);
    const sRev = await assignedShift(A.cg1, rA2, 10);
    await soon(sRev.id);
    const revoked = await call("POST", ARR(sRev.id), A.cg1.token, { latitude: 18.11, longitude: -66.166 });
    check("A14 after revoking consent, readings are refused again", revoked.status === 400, `status=${revoked.status}`);
    const race = await Promise.all([1, 2, 3, 4].map(() => call("POST", ARR(sRev.id), A.cg1.token, {})));
    check("A15 four simultaneous arrivals for one shift: exactly one stored",
      race.filter((r) => r.status === 201).length === 1 && (await q(`SELECT 1 FROM shift_arrivals WHERE shift_id=$1`, [sRev.id])).rowCount === 1, race.map((r) => r.status).join(","));
    const near2 = classifyProximity(distanceMeters({ lat: 18.11, lng: -66.166 }, { lat: 18.1115, lng: -66.166 }), 10);
    check("A16 proximity math: ~167 m is NEAR (radius 200 m) and rounded to 10 m", near2.proximity === "NEAR" && near2.distanceM === 170, JSON.stringify(near2));

    // ================================================================ T: late arrival
    const late = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '20 minutes',now()+interval '3 hours','confirmed') RETURNING id`, [orgA, rA2])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [orgA, late, A.cg2.membershipId]);
    const onTime = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '20 minutes',now()+interval '3 hours','confirmed') RETURNING id`, [orgA, rA])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [orgA, onTime, A.cg3.membershipId]);
    await call("POST", `/organizations/${orgA}/shifts/${onTime}/arrival`, A.cg3.token, {});
    await notifyLateShiftArrivals(); await notifyLateShiftArrivals();
    const lateRows = (await q<{ user_id: string; care_recipient_id: string | null; related_entity_id: string }>(`SELECT user_id, care_recipient_id, related_entity_id FROM notifications WHERE notification_type='SHIFT_LATE_ARRIVAL' AND organization_id=$1`, [orgA])).rows;
    check("T1 15 min without arrival or check-in: admins and supervisors notified once, no patient reference",
      lateRows.filter((r) => r.related_entity_id === late).length === 2 && lateRows.every((r) => r.care_recipient_id === null), `rows=${lateRows.length}`);
    check("T2 a shift whose caregiver already arrived is not reported", !lateRows.some((r) => r.related_entity_id === onTime));
    const lateB = (await q(`SELECT 1 FROM notifications WHERE notification_type='SHIFT_LATE_ARRIVAL' AND organization_id=$1`, [orgB])).rowCount;
    check("T3 no late notice crosses to another agency", lateB === 0);
    await call("POST", `/organizations/${orgA}/shifts/${late}/check-in`, A.cg2.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    const unread = (await q(`SELECT 1 FROM notifications WHERE notification_type='SHIFT_LATE_ARRIVAL' AND related_entity_id=$1 AND read_at IS NULL`, [late])).rowCount;
    check("T4 the caregiver's check-in resolves the late notice", unread === 0);

    // ================================================================ X: cancel a FILLED opportunity
    const S = `/organizations/${orgA}/smartmatch`;
    const consentSM = { consent: true, consentVersion: "smartmatch-consent-v1" };
    async function filled(days: number, cg: P) {
      const w = future(days);
      const d = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Acompañante", startsAt: w.scheduledStart, endsAt: w.scheduledEnd });
      const id = d.body.opportunity.id as string;
      await call("POST", `${S}/opportunities/${id}/publish`, A.admin.token);
      const ap = await call("POST", `${S}/opportunities/${id}/applications`, cg.token, consentSM);
      await call("POST", `${S}/applications/${ap.body.application.id}/decision`, A.admin.token, { decision: "APPROVE", confirm: true });
      return { id, appId: ap.body.application.id as string };
    }
    const o1 = await filled(12, A.cg2);
    const noLoc = await call("POST", `${S}/opportunities/${o1.id}/shift`, A.admin.token, { careRecipientId: rA });
    const withLoc = await call("POST", `${S}/opportunities/${o1.id}/shift`, A.admin.token, { careRecipientId: rA, serviceLocationId: newPrimary });
    const o1Shift = withLoc.body.shift?.id as string;
    const o1Loc = (await q<{ service_location_id: string }>(`SELECT service_location_id FROM shifts WHERE id=$1`, [o1Shift ?? randomUUID()])).rows[0]?.service_location_id;
    check("X1 SmartMatch shift: the admin must confirm which address applies; the shift keeps it",
      noLoc.status === 409 && noLoc.body.error === "SERVICE_LOCATION_REQUIRED" && withLoc.status === 201 && o1Loc === newPrimary, `${noLoc.status},${withLoc.status}`);
    const pub = await call("GET", `${S}/available-opportunities`, A.cg3.token);
    check("X2 published opportunities never carry an address", pub.status === 200 && !hasAddress(pub.body) && !/postal|latitude|access_notes/i.test(JSON.stringify(pub.body)));
    const blocked = await call("POST", `${S}/opportunities/${o1.id}/cancel`, A.admin.token, { reason: "NO_LONGER_NEEDED" });
    check("X3 a FILLED opportunity with an active shift cannot be cancelled (decide in Turnos first)", blocked.status === 409 && blocked.body.error === "LINKED_SHIFT_ACTIVE", `status=${blocked.status}`);
    const noReason = await call("POST", `${S}/opportunities/${o1.id}/cancel`, A.admin.token, {});
    const supCancel = await call("POST", `${S}/opportunities/${o1.id}/cancel`, A.supervisor.token, { reason: "OTHER" });
    const bCancel = await call("POST", `/organizations/${orgB}/smartmatch/opportunities/${o1.id}/cancel`, B.admin.token, { reason: "OTHER" });
    check("X4 reason required; supervisor and other agency cannot cancel", noReason.status === 400 && supCancel.status === 403 && bCancel.status === 404, `${noReason.status},${supCancel.status},${bCancel.status}`);
    await call("POST", `/organizations/${orgA}/shifts/${o1Shift}/cancel`, A.admin.token, {});
    const ok = await call("POST", `${S}/opportunities/${o1.id}/cancel`, A.admin.token, { reason: "SCHEDULE_CHANGED", note: "Nota interna sintética" });
    const mine = ((await call("GET", `${S}/my-applications`, A.cg2.token)).body.applications ?? [] as Json[]).find((a: Json) => a.id === o1.appId);
    const cancelNotice = await notices(A.cg2, "SMARTMATCH_OPPORTUNITY_CANCELLED");
    check("X5 after cancelling the shift in Turnos, the opportunity is cancelled; caregiver notified with the reason category only",
      ok.status === 200 && mine?.opportunity_status === "CANCELLED" && mine?.opportunity_cancellation_reason === "SCHEDULE_CHANGED"
      && !JSON.stringify(mine).includes("Nota interna") && cancelNotice.length === 1, `status=${ok.status}`);
    const again = await call("POST", `${S}/opportunities/${o1.id}/cancel`, A.admin.token, { reason: "OTHER" });
    const o2 = await filled(13, A.cg3);
    const noShift = await call("POST", `${S}/opportunities/${o2.id}/cancel`, A.admin.token, { reason: "COVERED_OTHERWISE" });
    check("X6 cannot cancel twice; a FILLED opportunity without a shift is cancelled directly", again.status === 409 && noShift.status === 200, `${again.status},${noShift.status}`);
    const o3 = await filled(14, A.cg1);
    let needReason = false; let noReopen = false;
    try { await q(`UPDATE smartmatch_opportunities SET status='CANCELLED' WHERE id=$1`, [o3.id]); } catch (e) { needReason = /CANCELLATION_REASON_REQUIRED/.test((e as Error).message); }
    try { await q(`UPDATE smartmatch_opportunities SET status='PUBLISHED' WHERE id=$1`, [o3.id]); } catch (e) { noReopen = /INVALID_STATUS_TRANSITION/.test((e as Error).message); }
    check("X7 database: no cancellation without reason; FILLED still never reopens", needReason && noReopen);
    const cancelledShiftStatus = (await q<{ status: string }>(`SELECT status::text FROM shifts WHERE id=$1`, [o1Shift])).rows[0].status;
    check("X8 SmartMatch never cancels or reassigns shifts by itself (shift was cancelled explicitly in Turnos)", cancelledShiftStatus === "cancelled");

    // ================================================================ P: platform
    const tables = ["care_recipient_locations", "care_recipient_location_events", "care_recipient_location_access_log",
      "care_recipient_location_change_requests", "shift_service_location_changes", "worker_location_consents", "shift_arrivals"];
    const leaks: string[] = [];
    for (const t of tables) if ((await asRuntime(A.platform.userId, orgA, `SELECT 1 FROM ${t} LIMIT 1`, [], true)).length) leaks.push(t);
    check("P1 ETNARA central / Tower super-admin reads no address, history, request, consent or arrival", leaks.length === 0, leaks.join(","));
    const forced = (await q<{ relname: string }>(`SELECT relname FROM pg_class WHERE relname = ANY($1) AND relforcerowsecurity`, [tables])).rows.length;
    check("P2 every Gate 6 table has FORCE row level security", forced === tables.length, `${forced}/${tables.length}`);
  } finally {
    await runtime.end();
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nGate 6 service locations: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
