/**
 * Phone linked to the account + SMS password recovery (migration 117), end to end over
 * HTTP as app_runtime. SMS_PROVIDER=test: codes stay in an in-process outbox, NOTHING is
 * sent. E-mails go to an in-process fake. Synthetic people and numbers (555-01xx).
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
const out = (line: string) => process.stdout.write(line + "\n");

const mails: Array<{ to: string; subject: string; html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const b = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: b.to?.[0] ?? b.to, subject: b.subject, html: b.html });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!url.startsWith("http://127.0.0.1")) throw new Error(`unexpected network call: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); if (level === "error" && process.env.DEBUG) original(...args); };
}
const SINCE = new Date(Date.now() - 3600_000).toISOString();
Object.assign(process.env, {
  PHONE_VERIFICATION_ENABLED: "true", SMS_PROVIDER: "test", PHONE_CODE_SECRET: randomBytes(32).toString("hex"),
  SMS_DAILY_CAP: "1000", PHONE_REQUIRED_SINCE: SINCE, RESEND_API_KEY: "test-only", ACTIVATION_BASE_URL: "https://app.example.invalid",
});

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
  const { env } = await import("../src/config/env.js");
  const { testSmsOutbox } = await import("../src/modules/accountSecurity/smsProvider.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  let ip = "203.0.113.1";
  async function call(method: string, path: string, token: string, body?: Json) {
    const started = performance.now();
    const res = await realFetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let parsed: Json = {}; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text, ms: performance.now() - started };
  }
  const outbox = () => testSmsOutbox();
  const lastCode = (to: string) => { const m = [...outbox()].reverse().find((x) => x.to === to); return m ? /código es (\d{6})/.exec(m.body)?.[1] ?? null : null; };
  const resetLimits = () => q(`DELETE FROM sms_send_log`);
  // Synthetic +1 787 555-01xx numbers (reserved for fiction).
  // A different area code each run, so reruns on the same database never collide.
  const AREA = String(200 + Math.floor(Math.random() * 700));
  const N = (n: number) => `+1${AREA}555${String(100 + n).padStart(4, "0")}`;

  const orgId = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`PV ${tag}`])).rows[0].id;
  const rec = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Ana','Sintetica','active') RETURNING id`, [orgId])).rows[0].id;
  type P = { email: string; userId: string; token: string };
  async function person(key: string, roles: string[], opts: { createdAt?: string; phone?: string } = {}): Promise<P> {
    const email = `pv-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status,created_at,phone) VALUES ($1,$2,'active',COALESCE($3::timestamptz,now()),$4) RETURNING id`, [email, hash, opts.createdAt ?? null, opts.phone ?? null])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    const login = await call("POST", "/auth/login", "", { email, password });
    return { email, userId, token: login.body.token };
  }
  const cg = await person("caregiver", ["WORKER"]);
  const sup = await person("supervisor", ["SUPERVISOR"]);
  const fam = await person("family", ["FAMILY"]);
  const legacy = await person("legacy", ["WORKER"], { createdAt: "2026-01-01T00:00:00Z" });
  const holder = await person("holder", ["FAMILY"], { phone: N(9) }); // legacy free-text phone, unverified

  try {
    // ------------------------------------------------------------ off by default
    env.PHONE_VERIFICATION_ENABLED = false;
    const offs = [await call("POST", "/me/phone/verification", cg.token, { phone: N(1) }), await call("POST", "/auth/password-reset/sms/request", "", { phone: N(1) }),
      await call("POST", "/auth/password-reset/sms/verify", "", { phone: N(1), code: "123456" })];
    const offState = await call("GET", "/me/account-security", cg.token);
    const offOptions = await call("GET", "/auth/recovery-options", "");
    env.PHONE_VERIFICATION_ENABLED = true;
    const onOptions = await call("GET", "/auth/recovery-options", "");
    check("V0 switched off (default): every phone route answers 404 FEATURE_NOT_ENABLED, nothing sent; state and the public options say SMS is unavailable (and available once on)",
      offs.every((r) => r.status === 404 && r.body.error === "FEATURE_NOT_ENABLED") && outbox().length === 0 && offState.body.security?.phoneVerificationAvailable === false
        && offOptions.text === '{"email":true,"sms":false}' && onOptions.text === '{"email":true,"sms":true}',
      offs.map((r) => r.status).join(","));

    // ------------------------------------------------------------ state
    const sCg = (await call("GET", "/me/account-security", cg.token)).body.security;
    const sFam = (await call("GET", "/me/account-security", fam.token)).body.security;
    const sLegacy = (await call("GET", "/me/account-security", legacy.token)).body.security;
    check("V1 new staff must link a phone; family only recommended; existing staff keep working (reminded, not required); e-mail masked",
      sCg.phoneRequired === true && sFam.phoneRequired === false && sFam.phoneRecommended === true && sLegacy.phoneRequired === false && sLegacy.phoneRecommended === true
        && /^p•••@example\.invalid$/.test(sCg.email) && sCg.phone === null, JSON.stringify({ cg: sCg.phoneRequired, fam: sFam.phoneRequired, legacy: sLegacy.phoneRequired, email: sCg.email }));

    // ------------------------------------------------------------ re-authentication
    await q(`UPDATE sessions SET reauthenticated_at = now() - interval '11 minutes' WHERE user_id=$1`, [cg.userId]);
    const noReauth = await call("POST", "/me/phone/verification", cg.token, { phone: `(${AREA}) 555-0101` });
    const badPw = await call("POST", "/me/reauthenticate", cg.token, { password: "incorrecta" });
    const goodPw = await call("POST", "/me/reauthenticate", cg.token, { password });
    check("V2 a phone change needs the password again after 10 min (401 REAUTHENTICATION_REQUIRED); a wrong password is refused",
      noReauth.status === 401 && noReauth.body.error === "REAUTHENTICATION_REQUIRED" && badPw.status === 401 && goodPw.status === 200 && outbox().length === 0,
      `${noReauth.status} ${badPw.status} ${goodPw.status}`);

    // ------------------------------------------------------------ link the phone
    const bad = await Promise.all(["+44 20 7946 0000", "555-0101", "(787) 155-0101", "787555010", "correo@x.com"].map((p) => call("POST", "/me/phone/verification", cg.token, { phone: p })));
    check("V3 only valid +1 numbers (Puerto Rico / US): others 400 PHONE_INVALID, nothing sent", bad.every((r) => r.status === 400) && outbox().length === 0, bad.map((r) => r.status).join(","));
    const start = await call("POST", "/me/phone/verification", cg.token, { phone: `(${AREA}) 555-0101` });
    const sms = outbox().at(-1);
    const code = lastCode(N(1));
    const stored = (await q<{ code_hash: string; phone: string }>(`SELECT code_hash, phone FROM account_phone_challenges WHERE user_id=$1 AND consumed_at IS NULL`, [cg.userId])).rows;
    check("V4 code sent to the typed number (normalised to +1…), text without names or health data, with the Android autofill line; only an HMAC stored",
      start.status === 202 && sms?.to === N(1) && !!code && /^ETNARA Care: tu código es \d{6}\. Vence en 10 minutos\. No lo compartas\.\n\n@app\.etnaracare\.com #\d{6}$/.test(sms!.body)
        && stored.length === 1 && stored[0].code_hash.length === 64 && !stored[0].code_hash.includes(code!), `${start.status} ${sms?.to}`);
    const again = await call("POST", "/me/phone/verification", cg.token, { phone: N(1) });
    check("V5 a second code within 60 s → 429 SMS_RATE_LIMITED", again.status === 429 && again.body.error === "SMS_RATE_LIMITED", `${again.status} ${again.body.error}`);
    const wrong = await call("POST", "/me/phone/verification/confirm", cg.token, { code: code === "000000" ? "111111" : "000000" });
    const right = await call("POST", "/me/phone/verification/confirm", cg.token, { code });
    const reuse = await call("POST", "/me/phone/verification/confirm", cg.token, { code });
    const sAfter = (await call("GET", "/me/account-security", cg.token)).body.security;
    check("V6 wrong code 400 CODE_INVALID; right code links it (masked •••-•••-0101, verified); the code works once",
      wrong.status === 400 && wrong.body.error === "CODE_INVALID" && right.status === 200 && right.body.phone === "•••-•••-0101" && reuse.status === 400
        && sAfter.phoneVerified === true && sAfter.phone === "•••-•••-0101" && sAfter.phoneRequired === false, `${wrong.status} ${right.status} ${reuse.status}`);

    // ------------------------------------------------------------ attempts limit and expiry
    await resetLimits();
    await call("POST", "/me/phone/verification", sup.token, { phone: N(2) });
    const supCode = lastCode(N(2))!;
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push((await call("POST", "/me/phone/verification/confirm", sup.token, { code: supCode === "999999" ? "888888" : "999999" })).status);
    const afterLock = await call("POST", "/me/phone/verification/confirm", sup.token, { code: supCode });
    const lockEvent = (await q(`SELECT 1 FROM account_security_events WHERE user_id=$1 AND event='PHONE_CODE_LOCKED'`, [sup.userId])).rowCount;
    await resetLimits();
    await call("POST", "/me/phone/verification", sup.token, { phone: N(2) });
    const supCode2 = lastCode(N(2))!;
    await q(`UPDATE account_phone_challenges SET expires_at = now() - interval '1 second' WHERE user_id=$1 AND consumed_at IS NULL`, [sup.userId]);
    const expired = await call("POST", "/me/phone/verification/confirm", sup.token, { code: supCode2 });
    check("V7 five wrong codes lock it (even the right one then fails, history records it); an expired code fails the same way",
      tries.every((s) => s === 400) && afterLock.status === 400 && lockEvent === 1 && expired.status === 400 && expired.body.error === "CODE_INVALID", `${tries.join(",")} after=${afterLock.status} exp=${expired.status}`);

    // ------------------------------------------------------------ login with the verified phone
    const formats = [`(${AREA}) 555-0101`, `${AREA}-555-0101`, `+1 ${AREA} 555 0101`, `1${AREA}5550101`];
    const logins = await Promise.all(formats.map((p) => call("POST", "/auth/login", "", { phone: p, password })));
    const unverified = await call("POST", "/auth/login", "", { phone: N(9), password });
    const wrongPw = await call("POST", "/auth/login", "", { phone: N(1), password: "no-es" });
    check("V8 log in with the verified phone written any usual way; an unverified number never opens the account (same 401 as a wrong password)",
      logins.every((r) => r.status === 200) && unverified.status === 401 && wrongPw.status === 401 && unverified.text === wrongPw.text, `${logins.map((r) => r.status).join(",")} unverified=${unverified.status}`);

    // ------------------------------------------------------------ numbers that belong to someone else
    await resetLimits();
    await call("POST", "/me/phone/verification", fam.token, { phone: N(1) }); // cg's verified number
    const famCode = lastCode(N(1))!;
    const taken = await call("POST", "/me/phone/verification/confirm", fam.token, { code: famCode });
    const cgStill = (await q<{ phone: string; phone_verified_at: Date | null }>(`SELECT phone, phone_verified_at FROM users WHERE id=$1`, [cg.userId])).rows[0];
    await resetLimits();
    await call("POST", "/me/phone/verification", fam.token, { phone: N(9) }); // holder's legacy unverified number
    const famGets = await call("POST", "/me/phone/verification/confirm", fam.token, { code: lastCode(N(9)) });
    const holderNow = (await q<{ phone: string | null }>(`SELECT phone FROM users WHERE id=$1`, [holder.userId])).rows[0];
    check("V9 a number verified by another account is never taken (409 PHONE_UNAVAILABLE, only after proving the code); a legacy UNVERIFIED holder loses it to whoever proves it",
      taken.status === 409 && taken.body.error === "PHONE_UNAVAILABLE" && cgStill.phone === N(1) && !!cgStill.phone_verified_at && famGets.status === 200 && holderNow.phone === null,
      `${taken.status} ${famGets.status} holder=${holderNow.phone}`);

    // ------------------------------------------------------------ change the phone
    await resetLimits();
    const mailsBefore = mails.length;
    await call("POST", "/me/phone/verification", cg.token, { phone: N(3) });
    const changed = await call("POST", "/me/phone/verification/confirm", cg.token, { code: lastCode(N(3)) });
    await new Promise((r) => setTimeout(r, 200));
    const notice = mails.slice(mailsBefore).find((m) => m.to === cg.email);
    const sChanged = (await call("GET", "/me/account-security", cg.token)).body.security;
    check("V10 changing the number: «changed», e-mail notice with only the last 4 digits, SMS recovery paused 72 h",
      changed.status === 200 && changed.body.changed === true && !!notice && notice.html.includes("0103") && !notice.html.includes(`${AREA}5550103`) && !notice.html.includes("0101")
        && sChanged.smsRecoveryAvailable === false && Math.abs(new Date(sChanged.smsRecoveryPausedUntil).getTime() - Date.now() - 72 * 3600_000) < 120_000,
      `${changed.status} notice=${!!notice} paused=${sChanged.smsRecoveryPausedUntil}`);

    // ------------------------------------------------------------ SMS recovery
    ip = "203.0.113.2";
    await resetLimits();
    const before = outbox().length;
    const paused = await call("POST", "/auth/password-reset/sms/request", "", { phone: N(3) });       // changed < 72 h ago
    const oldNum = await call("POST", "/auth/password-reset/sms/request", "", { phone: N(1) });       // no longer linked
    const nobody = await call("POST", "/auth/password-reset/sms/request", "", { phone: N(50) });     // no account
    const unverifiedNum = await call("POST", "/auth/password-reset/sms/request", "", { phone: N(2) }); // sup never verified it
    await new Promise((r) => setTimeout(r, 300));
    check("V11 same 200 {ok:true} for: number paused 72 h, old number, unknown number, unverified number — and NO code sent to any of them",
      [paused, oldNum, nobody, unverifiedNum].every((r) => r.status === 200 && r.text === '{"ok":true}') && outbox().length === before,
      [paused, oldNum, nobody, unverifiedNum].map((r) => r.status).join(","));
    await q(`UPDATE users SET phone_changed_at = now() - interval '73 hours' WHERE id=$1`, [cg.userId]);
    await resetLimits();
    const tReq: number[] = [], tNone: number[] = [];
    const req1 = await call("POST", "/auth/password-reset/sms/request", "", { phone: `${AREA}.555.0103` }); tReq.push(req1.ms);
    await new Promise((r) => setTimeout(r, 300));
    const resetCode = lastCode(N(3));
    for (let i = 0; i < 3; i++) { await resetLimits(); tReq.push((await call("POST", "/auth/password-reset/sms/request", "", { phone: N(3) })).ms); tNone.push((await call("POST", "/auth/password-reset/sms/request", "", { phone: N(60 + i) })).ms); }
    await new Promise((r) => setTimeout(r, 300));
    const finalCode = lastCode(N(3))!;
    check("V12 after 72 h the verified number gets a code; answers take the same time with or without an account (work done after answering)",
      req1.status === 200 && !!resetCode && Math.abs(Math.max(...tReq) - Math.max(...tNone)) < 80, `req=${req1.status} code=${!!resetCode} withAccount≈${Math.max(...tReq).toFixed(0)}ms none≈${Math.max(...tNone).toFixed(0)}ms`);
    const vUnknown = await call("POST", "/auth/password-reset/sms/verify", "", { phone: N(61), code: "123456" });
    const vWrong = await call("POST", "/auth/password-reset/sms/verify", "", { phone: N(3), code: finalCode === "123456" ? "654321" : "123456" });
    const vOldCode = resetCode !== finalCode ? await call("POST", "/auth/password-reset/sms/verify", "", { phone: N(3), code: resetCode }) : vWrong;
    check("V13 a wrong code, a code for an unknown number and a replaced code look identical (400 CODE_INVALID)",
      [vUnknown, vWrong, vOldCode].every((r) => r.status === 400 && r.text === vUnknown.text), [vUnknown, vWrong, vOldCode].map((r) => `${r.status}:${r.body.error}`).join(" "));
    const vRight = await call("POST", "/auth/password-reset/sms/verify", "", { phone: `(${AREA}) 555-0103`, code: finalCode });
    const newPw = `Sms-${randomBytes(8).toString("hex")}`;
    const meBefore = await call("GET", "/me", cg.token);
    const conf = await call("POST", "/auth/password-reset/confirm", "", { token: vRight.body.resetToken, password: newPw });
    const meAfter = await call("GET", "/me", cg.token);
    const reuseTok = await call("POST", "/auth/password-reset/confirm", "", { token: vRight.body.resetToken, password: newPw + "x" });
    const loginNew = await call("POST", "/auth/login", "", { phone: N(3), password: newPw });
    const reuseCode = await call("POST", "/auth/password-reset/sms/verify", "", { phone: N(3), code: finalCode });
    check("V14 right code → one-use reset token (10 min) for the existing confirm step; new password works, all sessions closed; code and token single use",
      vRight.status === 200 && /^[0-9a-f]{64}$/.test(vRight.body.resetToken) && vRight.body.expiresInSeconds === 600 && conf.status === 200 && meBefore.status === 200 && meAfter.status === 401
        && reuseTok.status === 400 && loginNew.status === 200 && reuseCode.status === 400, `${vRight.status} ${conf.status} me=${meBefore.status}->${meAfter.status} reuse=${reuseTok.status}/${reuseCode.status}`);

    // ------------------------------------------------------------ abuse: rate limits identical for account / non-account
    ip = "203.0.113.3";
    await resetLimits();
    const a = [await call("POST", "/auth/password-reset/sms/request", "", { phone: N(3) }), await call("POST", "/auth/password-reset/sms/request", "", { phone: N(3) })].map((r) => r.status);
    const b = [await call("POST", "/auth/password-reset/sms/request", "", { phone: N(70) }), await call("POST", "/auth/password-reset/sms/request", "", { phone: N(70) })].map((r) => r.status);
    await resetLimits();
    ip = "203.0.113.4";
    const ipFlood: number[] = [];
    for (let i = 0; i < 11; i++) ipFlood.push((await call("POST", "/auth/password-reset/sms/request", "", { phone: N(80 + i) })).status);
    check("V15 limits are the same with or without an account (60 s per number → 429) and an IP is stopped after 10 numbers per hour",
      JSON.stringify(a) === JSON.stringify(b) && a[1] === 429 && ipFlood.slice(0, 10).every((s) => s === 200) && ipFlood[10] === 429, `${a} | ${b} | ip=${ipFlood.join(",")}`);

    // ------------------------------------------------------------ data protection
    const priv = (await q<{ t: string; any: boolean }>(`SELECT t, has_table_privilege('app_runtime', t, 'SELECT') OR has_table_privilege('app_runtime', t, 'INSERT')
      OR has_table_privilege('app_runtime', t, 'UPDATE') OR has_table_privilege('app_runtime', t, 'DELETE') AS any
      FROM unnest(ARRAY['account_phone_challenges','sms_send_log','account_security_events']) t`)).rows;
    const events = (await q<{ phone_last4: string | null }>(`SELECT phone_last4 FROM account_security_events`)).rows;
    const logRows = (await q<{ phone_hash: string }>(`SELECT phone_hash FROM sms_send_log`)).rows;
    const codes = outbox().map((m) => /código es (\d{6})/.exec(m.body)?.[1]).filter(Boolean) as string[];
    const leak = logged.some((l) => (l.includes(`+1${AREA}555`) || l.includes(`${AREA}555`)) || codes.some((c) => l.includes(` ${c}`)));
    const bodyLeak = [sCg, sAfter, sChanged].some((s) => JSON.stringify(s).includes("555"));
    check("V16 the app has no direct access to codes, limits or history; history keeps only last 4 digits; limit log keeps only keyed hashes; no number or code in logs or API answers",
      priv.every((r) => !r.any) && events.every((e) => e.phone_last4 === null || /^\d{4}$/.test(e.phone_last4)) && logRows.every((r) => /^[0-9a-f]{64}$/.test(r.phone_hash)) && !leak && !bodyLeak,
      `priv=${priv.map((r) => r.any).join(",")} events=${events.length} leak=${leak} body=${bodyLeak}`);

    // ------------------------------------------------------------ family invitation by phone: verified only
    const inv = (await q<{ id: string }>(`INSERT INTO family_invitations (organization_id,care_recipient_id,invited_by_user_id,phone,relationship_type,invitation_token_hash,expires_at,can_view_photos)
      VALUES ($1,$2,$3,$4,'hija',$5,now()+interval '1 day',true) RETURNING id`, [orgId, rec, sup.userId, N(9), randomBytes(32).toString("hex")])).rows[0].id;
    const matches = async (userId: string) => (await q<{ ok: boolean }>(`SELECT ok FROM (SELECT set_config('app.current_user_id',$1,true)) s, LATERAL (SELECT app_family_invitation_allows_self_insert($2,$3,$4,'hija',true) ok) x`, [userId, inv, orgId, rec])).rows[0].ok;
    await q(`UPDATE users SET phone=$2, phone_verified_at=NULL WHERE id=$1`, [holder.userId, N(10)]);
    await q(`UPDATE family_invitations SET phone=$2 WHERE id=$1`, [inv, N(10)]);
    const unverifiedMatch = await matches(holder.userId);
    await q(`UPDATE users SET phone_verified_at=now() WHERE id=$1`, [holder.userId]);
    const verifiedMatch = await matches(holder.userId);
    check("V17 a family invitation sent to a phone only matches an account whose phone is VERIFIED", unverifiedMatch === false && verifiedMatch === true, `${unverifiedMatch} ${verifiedMatch}`);

    // ------------------------------------------------------------ existing account with a legacy free-text phone
    // A CHECK on every phone would be re-tested on ANY update of that row and lock the person out
    // (e-mail reset, backfills). Only verified numbers must be E.164.
    ip = "203.0.113.9";
    const oldStyle = `${AREA}-555-0142`;
    const lp = await person("legacyphone", ["WORKER"], { createdAt: "2026-01-01T00:00:00Z", phone: oldStyle });
    const lpState = (await call("GET", "/me/account-security", lp.token)).body.security;
    const lpByPhone = await call("POST", "/auth/login", "", { phone: oldStyle, password });
    const lpSms = await call("POST", "/auth/password-reset/sms/request", "", { phone: `+1${AREA}5550142` });
    const nMails = mails.length;
    await call("POST", "/auth/password-reset/request", "", { email: lp.email });
    let link: string | undefined;
    for (let i = 0; i < 30 && !link; i++) { link = mails.slice(nMails).map((m) => /reset-password\?token=([0-9a-f]{64})/.exec(m.html)?.[1]).find(Boolean); if (!link) await new Promise((r) => setTimeout(r, 100)); }
    const lpPw = `Legacy-${randomBytes(8).toString("hex")}`;
    const lpConfirm = await call("POST", "/auth/password-reset/confirm", "", { token: link, password: lpPw });
    const lpLogin = await call("POST", "/auth/login", "", { email: lp.email, password: lpPw });
    const lpKept = (await q<{ phone: string }>(`SELECT phone FROM users WHERE id=$1`, [lp.userId])).rows[0].phone;
    const badVerified = await q(`UPDATE users SET phone_verified_at = now() WHERE id=$1`, [lp.userId]).then(() => "accepted", (e: { code?: string }) => e.code);
    check("V18 an existing account with an old free-text phone keeps working: e-mail login and e-mail reset succeed, the old number is untouched, counts as unverified (no phone login, no SMS); a verified number must be E.164",
      !!lp.token && lpState.phoneVerified === false && lpState.phone === null && lpByPhone.status === 401 && lpSms.status === 200 && lastCode(`+1${AREA}5550142`) === null
        && !!link && lpConfirm.status === 200 && lpLogin.status === 200 && lpKept === oldStyle && badVerified === "23514",
      `confirm=${lpConfirm.status} login=${lpLogin.status} phoneLogin=${lpByPhone.status} verify=${badVerified}`);

    // ------------------------------------------------------------ pilot with real numbers: allow-list
    ip = "203.0.113.10";
    await resetLimits();
    const pilot = await person("pilot", ["SUPERVISOR"]);
    const outsider = await person("outsider", ["WORKER"]);
    (env as { PHONE_PILOT_USER_IDS: string[] | null }).PHONE_PILOT_USER_IDS = [pilot.userId];
    const sentBefore = outbox().length;
    const pState = (await call("GET", "/me/account-security", pilot.token)).body.security;
    const oState = (await call("GET", "/me/account-security", outsider.token)).body.security;
    const oStart = await call("POST", "/me/phone/verification", outsider.token, { phone: N(60) });
    const oConfirm = await call("POST", "/me/phone/verification/confirm", outsider.token, { code: "123456" });
    const pubOptions = await call("GET", "/auth/recovery-options", "");
    const pStart = await call("POST", "/me/phone/verification", pilot.token, { phone: N(61) });
    (env as { PHONE_PILOT_USER_IDS: string[] | null }).PHONE_PILOT_USER_IDS = null;
    const pubAfter = await call("GET", "/auth/recovery-options", "");
    check("V19 pilot allow-list: only listed accounts can link a phone (others: unavailable, never required, 404, no SMS); the public login does not offer SMS during the pilot",
      pState.phoneVerificationAvailable === true && oState.phoneVerificationAvailable === false && oState.phoneRequired === false
        && oStart.status === 404 && oStart.body.error === "FEATURE_NOT_ENABLED" && oConfirm.status === 404
        && pubOptions.text === '{"email":true,"sms":false}' && pStart.status === 202 && outbox().length === sentBefore + 1 && lastCode(N(61)) !== null
        && pubAfter.text === '{"email":true,"sms":true}',
      `pilot=${pState.phoneVerificationAvailable} outsider=${oState.phoneVerificationAvailable}/${oStart.status} public=${pubOptions.text} start=${pStart.status}`);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await db.end();
  }

  out("\nPhone verification + SMS recovery (test provider, nothing sent)\n");
  out("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) out(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  out(`\nPhone verification: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => { out(`Phone verification failed: ${String((error as Error)?.stack ?? error)}`); process.exit(1); });
