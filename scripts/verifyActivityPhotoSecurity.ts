/**
 * Activity photos — security and isolation (migration 115, PR 1). Synthetic
 * data only: no image is created; "files" are metadata rows that stand for
 * what PR 2's upload will create.
 *
 * Every access check runs as app_runtime with a real tenant context (RLS on),
 * like production. Covers: the 014 holes (other residents' rows, relinking a
 * foreign file), isolation between agencies / residents / relatives / staff,
 * ETNARA central, id tampering, privilege escalation, approval states and
 * history, consent and immediate revocation, the switch, and the HTTP paths
 * that exist today (PHOTO activity, family timeline).
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
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const runtime = new pg.Client({ connectionString: u.toString() });
  await runtime.connect();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  /** One statement as app_runtime with a tenant context. commit=false rolls back. */
  async function rt(userId: string, orgId: string, text: string, params: unknown[] = [], opts: { commit?: boolean; superadmin?: boolean } = {}) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`,
        [userId, orgId, opts.superadmin ? "true" : "false"]);
      const r = await runtime.query(text, params);
      await runtime.query(opts.commit ? "COMMIT" : "ROLLBACK");
      return { rows: r.rows as Json[], rowCount: r.rowCount ?? 0, error: null as string | null };
    } catch (e) {
      await runtime.query("ROLLBACK").catch(() => undefined);
      return { rows: [] as Json[], rowCount: 0, error: (e as Error).message };
    }
  }
  const count = async (userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false) => {
    const r = await rt(userId, orgId, text, params, { superadmin });
    return r.error ? `ERR ${r.error}` : Number(r.rows[0]?.n ?? r.rows.length);
  };
  const denied = (r: { error: string | null }, pattern: RegExp) => !!r.error && pattern.test(r.error);

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  }

  // ------------------------------------------------------------------ fixtures
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`PH A ${tag}`);
  const orgB = await org(`PH B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const photoType = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='PHOTO'`)).rows[0].id;
  const noteType = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='NOTE'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'PH') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
    await q(`INSERT INTO organization_care_event_types (organization_id,care_event_type_id,is_enabled) VALUES ($1,$2,true),($1,$3,true)`, [o, photoType, noteType]);
  }
  type P = { email: string; userId: string; token: string; owm?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `ph-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    return { email, userId, token: "", owm };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]),
    sup: await person("a-sup", orgA, ["SUPERVISOR"]),
    cg1: await person("a-cg1", orgA, ["WORKER"], true),
    cg2: await person("a-cg2", orgA, ["WORKER"], true),
    fam1: await person("a-fam1", orgA, ["FAMILY"]),
    fam1NoPhotos: await person("a-fam1np", orgA, ["FAMILY"]),
    fam2: await person("a-fam2", orgA, ["FAMILY"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("b-cg", orgB, ["WORKER"], true), fam: await person("b-fam", orgB, ["FAMILY"]) };
  const platform = await person("platform", orgA, []);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platform.userId]);
  const recipient = async (o: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetico',$2,'active') RETURNING id`, [o, `R-${tag}`])).rows[0].id;
  const r1 = await recipient(orgA);
  const r2 = await recipient(orgA);
  const rB = await recipient(orgB);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_photos) VALUES
    ($1,$4,$5,'hija','active',true), ($2,$4,$5,'hijo','active',false), ($3,$4,$6,'hija','active',true)`, [A.fam1.userId, A.fam1NoPhotos.userId, A.fam2.userId, orgA, r1, r2]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_photos) VALUES ($1,$2,$3,'hija','active',true)`, [B.fam.userId, orgB, rB]);

  // Shifts + accepted assignments, and synthetic activities recorded by each caregiver.
  async function shiftFor(o: string, rec: string, owm: string) {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '1 hour',now()+interval '3 hours','in_progress') RETURNING id`, [o, rec])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, owm]);
    return s;
  }
  async function activity(o: string, shift: string, rec: string, owm: string, ageHours = 0) {
    return (await q<{ id: string }>(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,note_text,occurred_at,created_at)
      VALUES ($1,$2,$3,$4,$5,'Actividad sintetica',now()-make_interval(hours=>$6::int),now()-make_interval(hours=>$6::int)) RETURNING id`, [o, shift, rec, owm, noteType, ageHours])).rows[0].id;
  }
  const sA1 = await shiftFor(orgA, r1, A.cg1.owm!);
  const sA2 = await shiftFor(orgA, r2, A.cg2.owm!);
  const sB = await shiftFor(orgB, rB, B.cg.owm!);
  const evR1 = await activity(orgA, sA1, r1, A.cg1.owm!);
  const evR1b = await activity(orgA, sA1, r1, A.cg1.owm!);
  const evR1old = await activity(orgA, sA1, r1, A.cg1.owm!, 13);
  const evR2 = await activity(orgA, sA2, r2, A.cg2.owm!);
  const evB = await activity(orgB, sB, rB, B.cg.owm!);
  const file = async (o: string, uploader: string, purpose: "ACTIVITY_PHOTO" | "PHOTO_CONSENT_FORM", key = randomUUID()) =>
    (await q<{ id: string }>(`INSERT INTO stored_files (scope_type,organization_id,storage_key,content_type,original_filename,size_bytes,uploaded_by_user_id,purpose)
      VALUES ('ORGANIZATION_OPERATIONAL',$1,$2,'image/jpeg','sintetica.jpg',1234,$3,$4) RETURNING id`, [o, `activity-photos/${o}/${key}`, uploader, purpose])).rows[0].id;
  const fR1 = await file(orgA, A.cg1.userId, "ACTIVITY_PHOTO");
  const fR1b = await file(orgA, A.cg1.userId, "ACTIVITY_PHOTO");
  const fR1c = await file(orgA, A.cg1.userId, "ACTIVITY_PHOTO");
  const fR2 = await file(orgA, A.cg2.userId, "ACTIVITY_PHOTO");
  const fB = await file(orgB, B.cg.userId, "ACTIVITY_PHOTO");
  const formA = await file(orgA, A.admin.userId, "PHOTO_CONSENT_FORM");
  const formA2 = await file(orgA, A.admin.userId, "PHOTO_CONSENT_FORM");
  const formB = await file(orgB, B.admin.userId, "PHOTO_CONSENT_FORM");
  const plainFile = (await q<{ id: string }>(`INSERT INTO stored_files (scope_type,organization_id,storage_key,content_type,original_filename,size_bytes,uploaded_by_user_id)
    VALUES ('ORGANIZATION_OPERATIONAL',$1,$2,'application/pdf','otro.pdf',10,$3) RETURNING id`, [orgA, `other/${randomUUID()}`, A.admin.userId])).rows[0].id;
  const enable = (o: string, on: boolean) => q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'ACTIVITY_PHOTOS',$2)
    ON CONFLICT (organization_id,feature_code) DO UPDATE SET enabled = EXCLUDED.enabled`, [o, on]);
  const attach = (who: P, o: string, ev: string, f: string) => rt(who.userId, o, `SELECT app_attach_activity_photo($1,$2) AS id`, [ev, f], { commit: true });
  const review = (who: P, o: string, id: string, d: string, reason: string | null = null) => rt(who.userId, o, `SELECT app_review_activity_photo($1,$2,$3) AS s`, [id, d, reason], { commit: true });
  const consent = (who: P, o: string, rec: string, type: string, form: string) =>
    rt(who.userId, o, `SELECT app_record_photo_consent($1,$2,'LEGAL_REPRESENTATIVE',$3) AS id`, [rec, type, form], { commit: true });
  const familySees = (who: P, o: string) => count(who.userId, o, `SELECT count(*) n FROM care_event_photos`);

  try {
    // ------------------------------------------------ 0. switch off by default
    const off = await attach(A.cg1, orgA, evR1, fR1);
    check("F1 the switch ACTIVITY_PHOTOS is off by default: attaching is refused", denied(off, /FEATURE_NOT_ENABLED/), String(off.error));
    await enable(orgA, true); await enable(orgB, true);

    // ------------------------------------------------ 1. consent before capture
    const noConsent = await attach(A.cg1, orgA, evR1, fR1);
    check("C1 no photo without the resident's capture consent", denied(noConsent, /PHOTO_CONSENT_REQUIRED/), String(noConsent.error));
    const famConsent = await consent(A.fam1, orgA, r1, "PHOTO_CAPTURE", formA);
    const cgConsent = await consent(A.cg1, orgA, r1, "PHOTO_CAPTURE", formA);
    const bConsent = await consent(B.admin, orgA, r1, "PHOTO_CAPTURE", formA);
    check("C2 relatives, caregivers and another agency's admin cannot record a consent",
      [famConsent, cgConsent, bConsent].every((r) => denied(r, /PHOTO_CONSENT_MANAGER_ONLY/)), [famConsent, cgConsent, bConsent].map((r) => r.error).join(" | "));
    const noForm = await rt(A.admin.userId, orgA, `SELECT app_record_photo_consent($1,'PHOTO_CAPTURE','PATIENT',$2)`, [r1, randomUUID()], { commit: true });
    const foreignForm = await consent(A.admin, orgA, r1, "PHOTO_CAPTURE", formB);
    const photoAsForm = await consent(A.admin, orgA, r1, "PHOTO_CAPTURE", fR1c);
    const otherAgencyResident = await consent(A.admin, orgA, rB, "PHOTO_CAPTURE", formA);
    check("C3 a consent needs this agency's signed consent form (not a missing, foreign or photo file) and this agency's resident",
      denied(noForm, /PHOTO_CONSENT_FORM_REQUIRED/) && denied(foreignForm, /PHOTO_CONSENT_FORM_REQUIRED/) && denied(photoAsForm, /PHOTO_CONSENT_FORM_REQUIRED/)
      && denied(otherAgencyResident, /PHOTO_RECIPIENT_NOT_FOUND/), [noForm, foreignForm, photoAsForm, otherAgencyResident].map((r) => r.error).join(" | "));
    const cap = await consent(A.sup, orgA, r1, "PHOTO_CAPTURE", formA);
    const capDup = await consent(A.admin, orgA, r1, "PHOTO_CAPTURE", formA);
    check("C4 a supervisor records it (with the signed form); only one active consent per type", !cap.error && denied(capDup, /PHOTO_CONSENT_ALREADY_ACTIVE/), `${cap.error} | ${capDup.error}`);
    const capId = cap.rows[0]?.id as string;
    await consent(A.admin, orgA, r2, "PHOTO_CAPTURE", formA2);
    await consent(B.admin, orgB, rB, "PHOTO_CAPTURE", formB);
    await consent(B.admin, orgB, rB, "PHOTO_SHARE_FAMILY", formB);

    // ------------------------------------------------ 2. attaching (id tampering)
    const p1 = await attach(A.cg1, orgA, evR1, fR1);
    const p1id = p1.rows[0]?.id as string;
    check("W1 the caregiver who recorded the activity attaches her own photo; it starts «pending»",
      !p1.error && (await q(`SELECT share_status FROM care_event_photos WHERE id=$1`, [p1id])).rows[0]?.share_status === "pending", String(p1.error));
    const r2p = await attach(A.cg2, orgA, evR2, fR2);
    const r2id = r2p.rows[0]?.id as string;
    const tampering = [
      ["other caregiver's file on own activity", await attach(A.cg2, orgA, evR2, fR1b), /PHOTO_FILE_NOT_FOUND/],
      ["own file on another caregiver's activity", await attach(A.cg1, orgA, evR2, fR1b), /PHOTO_FORBIDDEN/],
      ["another agency's file", await attach(A.cg1, orgA, evR1b, fB), /PHOTO_FILE_NOT_FOUND/],
      ["another agency's activity", await attach(A.cg1, orgA, evB, fR1b), /PHOTO_FORBIDDEN/],
      ["a consent form used as photo", await attach(A.cg1, orgA, evR1b, formA), /PHOTO_FILE_NOT_FOUND/],
      ["an ordinary operational file", await attach(A.cg1, orgA, evR1b, plainFile), /PHOTO_FILE_NOT_FOUND/],
      ["the same file twice", await attach(A.cg1, orgA, evR1b, fR1), /PHOTO_FILE_ALREADY_LINKED/],
      ["an activity older than 12 h", await attach(A.cg1, orgA, evR1old, fR1b), /PHOTO_FORBIDDEN/],
      ["a relative", await attach(A.fam1, orgA, evR1b, fR1b), /PHOTO_FORBIDDEN/],
      ["agency B's caregiver with agency A's context", await attach(B.cg, orgA, evR1b, fR1b), /PHOTO_FORBIDDEN/],
      ["ETNARA central", await rt(platform.userId, orgA, `SELECT app_attach_activity_photo($1,$2)`, [evR1b, fR1b], { commit: true, superadmin: true }), /PHOTO_FORBIDDEN/],
    ] as const;
    const bad = tampering.filter(([, r, re]) => !denied(r, re));
    check("W2 attaching is refused for every tampered id or wrong actor (11 cases)", bad.length === 0, bad.map(([n, r]) => `${n}: ${r.error ?? "ALLOWED"}`).join(" | ") || "all refused");

    // ------------------------------------------------ 3. no direct writes (the 014 hole)
    const famInsert = await rt(A.fam1.userId, orgA, `INSERT INTO care_event_photos (organization_id,care_event_id,file_id,care_recipient_id) VALUES ($1,$2,$3,$4)`, [orgA, evR1b, fR2, r1], { commit: true });
    const famReadFile = await count(A.fam1.userId, orgA, `SELECT count(*) n FROM stored_files WHERE id=$1`, [fR2]);
    check("H1 the 014 hole is closed: a relative cannot link another resident's file (permission denied) nor read that file",
      denied(famInsert, /permission denied/) && famReadFile === 0, `${famInsert.error} | file=${famReadFile}`);
    const writes = [
      await rt(A.cg1.userId, orgA, `INSERT INTO care_event_photos (organization_id,care_event_id,file_id,care_recipient_id) VALUES ($1,$2,$3,$4)`, [orgA, evR1b, fR1b, r1], { commit: true }),
      await rt(A.admin.userId, orgA, `UPDATE care_event_photos SET share_status='approved' WHERE id=$1`, [p1id], { commit: true }),
      await rt(A.admin.userId, orgA, `DELETE FROM care_event_photos WHERE id=$1`, [p1id], { commit: true }),
      await rt(A.fam1.userId, orgA, `UPDATE care_event_photos SET care_recipient_id=$2 WHERE id=$1`, [r2id, r1], { commit: true }),
    ];
    check("H2 nobody writes care_event_photos directly (caregiver insert, manager approve/delete, relative re-point): permission denied",
      writes.every((r) => denied(r, /permission denied/)), writes.map((r) => r.error).join(" | "));
    const superUpd = await q(`UPDATE care_event_photos SET care_recipient_id=$2 WHERE id=$1`, [p1id, r2]).then(() => "ALLOWED", (e) => (e as Error).message);
    const superDel = await q(`DELETE FROM care_event_photos WHERE id=$1`, [p1id]).then(() => "ALLOWED", (e) => (e as Error).message);
    const superSkip = await q(`UPDATE care_event_photos SET share_status='withdrawn', reviewed_at=now(), reviewed_by_user_id=$2, review_reason='x x x' WHERE id=$1`, [p1id, A.admin.userId]).then(() => "ALLOWED", (e) => (e as Error).message);
    const superPurpose = await q(`UPDATE stored_files SET purpose=NULL WHERE id=$1`, [fR1]).then(() => "ALLOWED", (e) => (e as Error).message);
    check("H3 even the database owner cannot re-point, delete, skip states of a photo, or change a file's purpose (triggers)",
      /PHOTO_IDENTITY_IMMUTABLE/.test(superUpd) && /PHOTO_HISTORY_KEPT/.test(superDel) && /PHOTO_INVALID_TRANSITION/.test(superSkip) && /STORED_FILE_IDENTITY_IMMUTABLE/.test(superPurpose),
      `${superUpd} | ${superDel} | ${superSkip} | ${superPurpose}`);

    // ------------------------------------------------ 4. who reads what
    const reads = {
      adminA: await count(A.admin.userId, orgA, `SELECT count(*) n FROM care_event_photos`),
      supA: await count(A.sup.userId, orgA, `SELECT count(*) n FROM care_event_photos`),
      cg1: await count(A.cg1.userId, orgA, `SELECT count(*) n FROM care_event_photos`),
      cg2: await count(A.cg2.userId, orgA, `SELECT count(*) n FROM care_event_photos`),
      fam1: await familySees(A.fam1, orgA),
      fam2: await familySees(A.fam2, orgA),
      adminBctxA: await count(B.admin.userId, orgA, `SELECT count(*) n FROM care_event_photos`),
      adminB: await count(B.admin.userId, orgB, `SELECT count(*) n FROM care_event_photos WHERE organization_id=$1`, [orgA]),
      platform: await count(platform.userId, orgA, `SELECT count(*) n FROM care_event_photos`, [], true),
    };
    check("R1 managers see their agency's photos; each caregiver only hers; relatives nothing while pending; other agencies and ETNARA central nothing",
      reads.adminA === 2 && reads.supA === 2 && reads.cg1 === 1 && reads.cg2 === 1 && reads.fam1 === 0 && reads.fam2 === 0
      && reads.adminBctxA === 0 && reads.adminB === 0 && reads.platform === 0, JSON.stringify(reads));
    const fileReads = {
      admin: await count(A.admin.userId, orgA, `SELECT count(*) n FROM stored_files WHERE purpose IS NOT NULL`),
      cg1: await count(A.cg1.userId, orgA, `SELECT count(*) n FROM stored_files WHERE purpose IS NOT NULL`),
      cg2SeesCg1: await count(A.cg2.userId, orgA, `SELECT count(*) n FROM stored_files WHERE id=$1`, [fR1]),
      fam1: await count(A.fam1.userId, orgA, `SELECT count(*) n FROM stored_files`),
      platform: await count(platform.userId, orgA, `SELECT count(*) n FROM stored_files`, [], true),
      cgPlain: await count(A.cg2.userId, orgA, `SELECT count(*) n FROM stored_files WHERE id=$1`, [plainFile]),
    };
    check("R2 photo/consent-form files (storage keys): managers and the uploader only; relatives and ETNARA central see no stored_files; ordinary files unchanged for staff",
      fileReads.admin === 6 && fileReads.cg1 === 3 && fileReads.cg2SeesCg1 === 0 && fileReads.fam1 === 0 && fileReads.platform === 0 && fileReads.cgPlain === 1, JSON.stringify(fileReads));
    const consentReads = {
      admin: await count(A.admin.userId, orgA, `SELECT count(*) n FROM consent_records WHERE consent_type LIKE 'PHOTO%'`),
      cg1: await count(A.cg1.userId, orgA, `SELECT count(*) n FROM consent_records WHERE consent_type LIKE 'PHOTO%'`),
      fam1: await count(A.fam1.userId, orgA, `SELECT count(*) n FROM consent_records WHERE consent_type LIKE 'PHOTO%'`),
      platform: await count(platform.userId, orgA, `SELECT count(*) n FROM consent_records`, [], true),
      cgAsk: (await rt(A.cg1.userId, orgA, `SELECT app_photo_consent_active($1,$2,'PHOTO_CAPTURE') AS a`, [orgA, r1])).rows[0]?.a,
      cgAskOtherOrg: (await rt(A.cg1.userId, orgA, `SELECT app_photo_consent_active($1,$2,'PHOTO_CAPTURE') AS a`, [orgB, rB])).rows[0]?.a,
    };
    check("R3 photo consents (signed form reference): managers only; others get just yes/no for their own agency; ETNARA central nothing",
      consentReads.admin === 2 && consentReads.cg1 === 0 && consentReads.fam1 === 0 && consentReads.platform === 0 && consentReads.cgAsk === true && consentReads.cgAskOtherOrg === false,
      JSON.stringify(consentReads));

    // ------------------------------------------------ 5. approval and history
    const asCg = await review(A.cg1, orgA, p1id, "APPROVE");
    const asFam = await review(A.fam1, orgA, p1id, "APPROVE");
    const asB = await review(B.admin, orgA, p1id, "APPROVE");
    const asPlatform = await rt(platform.userId, orgA, `SELECT app_review_activity_photo($1,'APPROVE',NULL)`, [p1id], { commit: true, superadmin: true });
    check("A1 only the agency's administrator or supervisor reviews (caregiver, relative, other agency, ETNARA central refused)",
      [asCg, asFam, asB, asPlatform].every((r) => denied(r, /PHOTO_REVIEW_MANAGER_ONLY/)), [asCg, asFam, asB, asPlatform].map((r) => r.error).join(" | "));
    const noShare = await review(A.admin, orgA, p1id, "APPROVE");
    check("A2 approval needs the family-sharing consent", denied(noShare, /PHOTO_CONSENT_REQUIRED/), String(noShare.error));
    const share = await consent(A.admin, orgA, r1, "PHOTO_SHARE_FAMILY", formA);
    const shareId = share.rows[0]?.id as string;
    const rejectNoReason = await review(A.admin, orgA, p1id, "REJECT", " ");
    const pendingWithdraw = await review(A.admin, orgA, p1id, "WITHDRAW", "Retiro de prueba");
    const fakeId = await review(A.admin, orgA, randomUUID(), "APPROVE");
    const otherAgencyPhoto = await review(A.admin, orgA, (await attach(B.cg, orgB, evB, fB)).rows[0]?.id as string, "APPROVE");
    check("A3 a reason is required to reject; invalid transitions, unknown ids and another agency's photo are refused",
      denied(rejectNoReason, /PHOTO_REASON_REQUIRED/) && denied(pendingWithdraw, /PHOTO_INVALID_TRANSITION/) && denied(fakeId, /PHOTO_NOT_FOUND/) && denied(otherAgencyPhoto, /PHOTO_NOT_FOUND/),
      [rejectNoReason, pendingWithdraw, fakeId, otherAgencyPhoto].map((r) => r.error).join(" | "));
    const approve = await review(A.sup, orgA, p1id, "APPROVE");
    const seen = { fam1: await familySees(A.fam1, orgA), fam1NoPhotos: await familySees(A.fam1NoPhotos, orgA), fam2: await familySees(A.fam2, orgA), famB: await familySees(B.fam, orgA) };
    check("A4 once approved, only the relative of THAT resident with photo permission sees it",
      !approve.error && seen.fam1 === 1 && seen.fam1NoPhotos === 0 && seen.fam2 === 0 && seen.famB === 0, `${approve.error} ${JSON.stringify(seen)}`);
    const famOwnFile = await count(A.fam1.userId, orgA, `SELECT count(*) n FROM stored_files WHERE id=$1`, [fR1]);
    check("A5 even for an approved photo the relative never gets the storage reference (PR 2 streams it)", famOwnFile === 0, String(famOwnFile));
    const withdraw = await review(A.admin, orgA, p1id, "WITHDRAW", "Retirada por la agencia");
    const afterWithdraw = await familySees(A.fam1, orgA);
    await review(A.admin, orgA, p1id, "APPROVE");
    const history = (await rt(A.admin.userId, orgA, `SELECT action, from_status, to_status, actor_user_id, reason FROM care_event_photo_events WHERE photo_id=$1 ORDER BY occurred_at, action`, [p1id])).rows;
    const histOk = history.map((h) => h.action).join(",") === "UPLOADED,APPROVED,WITHDRAWN,APPROVED"
      && history[0].actor_user_id === A.cg1.userId && history[1].actor_user_id === A.sup.userId && history[2].reason === "Retirada por la agencia";
    check("A6 withdrawing hides it at once; every change is in the history with actor and reason",
      !withdraw.error && afterWithdraw === 0 && histOk, `${afterWithdraw} ${history.map((h) => `${h.action}:${h.from_status}->${h.to_status}`).join(" ")}`);
    const histReads = {
      cg1: await count(A.cg1.userId, orgA, `SELECT count(*) n FROM care_event_photo_events`),
      fam1: await count(A.fam1.userId, orgA, `SELECT count(*) n FROM care_event_photo_events`),
      platform: await count(platform.userId, orgA, `SELECT count(*) n FROM care_event_photo_events`, [], true),
      adminB: await count(B.admin.userId, orgB, `SELECT count(*) n FROM care_event_photo_events WHERE organization_id=$1`, [orgA]),
    };
    const histUpd = await rt(A.admin.userId, orgA, `UPDATE care_event_photo_events SET reason='x' WHERE photo_id=$1`, [p1id], { commit: true });
    const histOwner = await q(`DELETE FROM care_event_photo_events WHERE photo_id=$1`, [p1id]).then(() => "ALLOWED", (e) => (e as Error).message);
    check("A7 the history is for managers only and append-only (app_runtime has no write; even the owner cannot delete)",
      histReads.cg1 === 0 && histReads.fam1 === 0 && histReads.platform === 0 && histReads.adminB === 0 && denied(histUpd, /permission denied/) && /HISTORY_APPEND_ONLY/.test(histOwner),
      `${JSON.stringify(histReads)} ${histUpd.error} ${histOwner}`);

    // ------------------------------------------------ 6. revocation, switch, relationship
    const revokeByCg = await rt(A.cg1.userId, orgA, `SELECT app_revoke_photo_consent($1,'Revocado por la familia')`, [shareId], { commit: true });
    const revokeNoReason = await rt(A.admin.userId, orgA, `SELECT app_revoke_photo_consent($1,'')`, [shareId], { commit: true });
    check("V1 only managers revoke, with a reason", denied(revokeByCg, /PHOTO_CONSENT_MANAGER_ONLY/) && denied(revokeNoReason, /PHOTO_CONSENT_REASON_REQUIRED/), `${revokeByCg.error} | ${revokeNoReason.error}`);
    const beforeRevoke = await familySees(A.fam1, orgA);
    const revoke = await rt(A.admin.userId, orgA, `SELECT app_revoke_photo_consent($1,'Revocado por la representante')`, [shareId], { commit: true });
    const afterRevoke = await familySees(A.fam1, orgA);
    check("V2 revoking the sharing consent blocks the relative immediately", beforeRevoke === 1 && !revoke.error && afterRevoke === 0, `${beforeRevoke} -> ${afterRevoke} ${revoke.error}`);
    const share2 = await consent(A.admin, orgA, r1, "PHOTO_SHARE_FAMILY", formA2);
    const afterRenew = await familySees(A.fam1, orgA);
    await review(A.admin, orgA, p1id, "WITHDRAW", "Revision tras nuevo consentimiento");
    await review(A.admin, orgA, p1id, "APPROVE");
    const afterReapprove = await familySees(A.fam1, orgA);
    check("V3 a new consent does not bring old photos back by itself: the agency must approve them again",
      !share2.error && afterRenew === 0 && afterReapprove === 1, `renew=${afterRenew} reapprove=${afterReapprove}`);
    await rt(A.admin.userId, orgA, `SELECT app_revoke_photo_consent($1,'Revoca la captura')`, [capId], { commit: true });
    const afterCapRevoke = await familySees(A.fam1, orgA);
    const attachAfterRevoke = await attach(A.cg1, orgA, evR1b, fR1b);
    check("V4 revoking the capture consent hides the photos taken under it and blocks new ones", afterCapRevoke === 0 && denied(attachAfterRevoke, /PHOTO_CONSENT_REQUIRED/),
      `${afterCapRevoke} ${attachAfterRevoke.error}`);
    const capAgain = await consent(A.admin, orgA, r1, "PHOTO_CAPTURE", formA);
    const sameAfterNewCapture = await familySees(A.fam1, orgA);
    const consentEdit = await rt(A.admin.userId, orgA, `UPDATE consent_records SET signer_role='PATIENT' WHERE id=$1`, [capAgain.rows[0]?.id], { commit: true });
    const consentDelete = await rt(A.admin.userId, orgA, `DELETE FROM consent_records WHERE id=$1`, [capAgain.rows[0]?.id], { commit: true });
    const consentUnrevoke = await rt(A.admin.userId, orgA, `UPDATE consent_records SET revoked_at=NULL, revoked_by_user_id=NULL, revocation_reason=NULL WHERE id=$1`, [capId], { commit: true });
    check("V5 photos stay tied to their original capture consent; consents can only be revoked (no edit, delete or un-revoke)",
      sameAfterNewCapture === 0 && denied(consentEdit, /PHOTO_CONSENT_ONLY_REVOCABLE/) && denied(consentDelete, /PHOTO_CONSENT_APPEND_ONLY/) && denied(consentUnrevoke, /PHOTO_CONSENT_ONLY_REVOCABLE/),
      `${sameAfterNewCapture} | ${consentEdit.error} | ${consentDelete.error} | ${consentUnrevoke.error}`);
    // Fresh approved photo for the switch / relationship checks.
    const fR1d = await file(orgA, A.cg1.userId, "ACTIVITY_PHOTO");
    const p3 = await attach(A.cg1, orgA, evR1b, fR1d);
    await review(A.admin, orgA, p3.rows[0]?.id as string, "APPROVE");
    const visible = await familySees(A.fam1, orgA);
    await enable(orgA, false);
    const switchedOff = await familySees(A.fam1, orgA);
    const reviewOff = await review(A.admin, orgA, p3.rows[0]?.id as string, "WITHDRAW", "Interruptor apagado");
    await enable(orgA, true);
    await q(`UPDATE family_relationships SET status='revoked' WHERE user_id=$1`, [A.fam1.userId]);
    const relRevoked = await familySees(A.fam1, orgA);
    await q(`UPDATE family_relationships SET status='active', can_view_photos=false WHERE user_id=$1`, [A.fam1.userId]);
    const noPermission = await familySees(A.fam1, orgA);
    await q(`UPDATE family_relationships SET can_view_photos=true WHERE user_id=$1`, [A.fam1.userId]);
    check("V6 switching the feature off, revoking the relationship or removing photo permission hides photos immediately",
      visible === 1 && switchedOff === 0 && denied(reviewOff, /FEATURE_NOT_ENABLED/) && relRevoked === 0 && noPermission === 0,
      `${visible} off=${switchedOff} rel=${relRevoked} perm=${noPermission} ${reviewOff.error}`);
    const famOrgB = await count(A.fam1.userId, orgB, `SELECT count(*) n FROM care_event_photos`);
    check("V7 a relative who switches the agency context sees nothing of the other agency", famOrgB === 0, String(famOrgB));
    const retention = await q(`SELECT round(extract(epoch FROM (retention_until - created_at))/86400) d FROM care_event_photos WHERE id=$1`, [p3.rows[0]?.id])
      .then((r) => r.rows[0]?.d, (e) => `ERR ${(e as Error).message}`);
    check("T1 retention date recorded at 180 days; nothing is deleted automatically", Number(retention) === 180, String(retention));

    // ------------------------------------------------ 7. HTTP paths that exist today
    for (const p of [A.admin, A.cg1, A.fam1, A.fam2]) {
      const r = await call("POST", "/auth/login", "", { email: p.email, password });
      if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
      p.token = r.body.token;
      await call("POST", "/me/active-organization", p.token, { organizationId: orgA });
    }
    await q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,actor_user_id)
      SELECT $1,$2,$3,id,'check_in',$4 FROM verification_methods WHERE code='CAREGIVER_SESSION'`, [orgA, sA1, A.cg1.owm, A.cg1.userId]);
    const httpFile = await file(orgA, A.cg1.userId, "ACTIVITY_PHOTO");
    const httpOk = await call("POST", `/organizations/${orgA}/shifts/${sA1}/care-events`, A.cg1.token, { typeCode: "PHOTO", careRecipientId: r1, storedFileId: httpFile });
    const httpForeign = await call("POST", `/organizations/${orgA}/shifts/${sA1}/care-events`, A.cg1.token, { typeCode: "PHOTO", careRecipientId: r1, storedFileId: fR2 });
    const leftover = Number((await q(`SELECT count(*) n FROM care_events WHERE shift_id=$1 AND care_event_type_id=$2`, [sA1, photoType])).rows[0].n);
    check("P1 HTTP: a PHOTO activity with her own file is stored as «pending»; another resident's file is refused and leaves no activity",
      httpOk.status === 201 && httpForeign.status === 400 && httpForeign.body.error === "PHOTO_FILE_NOT_FOUND" && leftover === 1,
      `${httpOk.status} ${httpForeign.status} ${String(httpForeign.body.error)} activities=${leftover}`);
    const tl1 = await call("GET", `/organizations/${orgA}/care-recipients/${r1}/timeline`, A.fam1.token);
    const photos1 = (tl1.body.items as Json[] ?? []).filter((i) => i.type === "PHOTO");
    const tl2 = await call("GET", `/organizations/${orgA}/care-recipients/${r1}/timeline`, A.fam2.token);
    check("P2 HTTP: the family timeline marks the new (pending) photo as not visible; another resident's relative gets 404",
      tl1.status === 200 && photos1.length === 1 && photos1[0].photo?.visible === false && tl2.status === 404, `${tl1.status} ${JSON.stringify(photos1.map((p) => p.photo))} ${tl2.status}`);
    const leak = JSON.stringify(tl1.body).includes("activity-photos/") || JSON.stringify(tl1.body).includes(httpFile);
    check("P3 HTTP: no storage key or file id reaches the family", !leak, String(leak));
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end().catch(() => undefined);
    await db.end();
  }

  console.log("\nActivity photos · security and isolation (PR 1)\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nActivity photo security: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Activity photo security verification failed:", error);
  process.exit(1);
});
