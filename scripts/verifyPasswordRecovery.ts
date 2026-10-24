/**
 * Password recovery by e-mail, end to end over HTTP as app_runtime (synthetic data only).
 *
 * The e-mail provider is replaced inside this process by a fake that records
 * the message and answers after 400 ms (like a real provider), so the check
 * can read the link and measure whether response times reveal an account.
 * Nothing is sent anywhere. Creates its own synthetic agency (.invalid e-mails).
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

// ---------------------------------------------------------------- fake e-mail provider (in-process only)
const mails: Array<{ to: string; html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    await new Promise((r) => setTimeout(r, 400));
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, html: String(body.html ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.ACTIVATION_BASE_URL = "https://app.example.invalid";

// Everything the server logs, to prove no address or token is ever written.
const logged: string[] = [];
const out = (line: string) => process.stdout.write(line + "\n");
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); if (level === "error") original(...args); };
}

const linkToken = (html: string) => /\/reset-password\?token=([0-9a-f]{64})/.exec(html)?.[1] ?? null;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

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

  // Each section comes from its own client address (the app trusts one proxy hop), so the
  // per-IP limit of one section never decides another section's result.
  let clientIp = "198.51.100.1";
  async function call(method: string, path: string, token: string, body?: Json) {
    const started = performance.now();
    const res = await realFetch(base + path, {
      method, headers: { "Content-Type": "application/json", "X-Forwarded-For": clientIp, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text, ms: performance.now() - started };
  }
  const waitMail = async (to: string, count: number) => {
    for (let i = 0; i < 40 && mails.filter((m) => m.to === to).length < count; i++) await new Promise((r) => setTimeout(r, 50));
    return mails.filter((m) => m.to === to);
  };

  const orgId = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`PR ${tag}`])).rows[0].id;
  async function person(key: string, roles: string[], status = "active") {
    const email = `pr-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,$3) RETURNING id`, [email, hash, status])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    return { email, userId };
  }
  const admin = await person("admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person("supervisor", ["SUPERVISOR"]);
  const cg = await person("caregiver", ["WORKER"]);
  const fam = await person("family", ["FAMILY"]);
  const disabled = await person("disabled", ["WORKER"], "disabled");
  const floodUser = await person("flood", ["FAMILY"]);
  const unknown = `pr-nobody-${tag}@example.invalid`;

  try {
    // ------------------------------------------------------------ no enumeration
    const known = await call("POST", "/auth/password-reset/request", "", { email: cg.email });
    const none = await call("POST", "/auth/password-reset/request", "", { email: unknown });
    const off = await call("POST", "/auth/password-reset/request", "", { email: disabled.email });
    const upper = await call("POST", "/auth/password-reset/request", "", { email: `  ${fam.email.toUpperCase()}  ` });
    check("P1 same answer for an account, no account, a disabled account and a differently written address: 200 {ok:true}, byte for byte",
      [known, none, off, upper].every((r) => r.status === 200 && r.text === '{"ok":true}'), [known, none, off, upper].map((r) => `${r.status}:${r.text}`).join(" "));
    const cgMails = await waitMail(cg.email, 1);
    const famMails = await waitMail(fam.email, 1);
    await new Promise((r) => setTimeout(r, 600));
    check("P2 only real, active accounts get an e-mail (none for the unknown or the disabled address)",
      cgMails.length === 1 && famMails.length === 1 && !mails.some((m) => m.to === unknown || m.to === disabled.email), `${mails.map((m) => m.to.split("@")[0]).join(",")}`);
    const t1 = linkToken(cgMails[0]?.html ?? "");
    const stored = (await q<{ token_hash: string; ttl: number }>(`SELECT token_hash, extract(epoch FROM expires_at - created_at)::int AS ttl FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL`, [cg.userId])).rows;
    check("P3 the e-mail links to /reset-password with a 64-hex token; only its hash is stored, valid 30 minutes",
      !!t1 && stored.length === 1 && stored[0].token_hash !== t1 && stored[0].ttl === 1800, `link=${!!t1} rows=${stored.length} ttl=${stored[0]?.ttl}`);

    clientIp = "198.51.100.2";
    // Timing: the provider takes 400 ms; the answer must not wait for it (nor for the token).
    const tKnown: number[] = [], tNone: number[] = [];
    for (let i = 0; i < 4; i++) {
      tKnown.push((await call("POST", "/auth/password-reset/request", "", { email: sup.email })).ms);
      tNone.push((await call("POST", "/auth/password-reset/request", "", { email: `pr-ghost${i}-${tag}@example.invalid` })).ms);
    }
    check("P4 response time does not reveal an account (median with account vs without differ < 60 ms; neither waits for the 400 ms provider)",
      Math.abs(median(tKnown) - median(tNone)) < 60 && Math.max(...tKnown, ...tNone) < 300, `known=${median(tKnown).toFixed(0)}ms none=${median(tNone).toFixed(0)}ms max=${Math.max(...tKnown, ...tNone).toFixed(0)}ms`);

    clientIp = "198.51.100.3";
    // ------------------------------------------------------------ confirm: single use, sessions closed
    const loginCg = await call("POST", "/auth/login", "", { email: cg.email, password });
    const meBefore = await call("GET", "/me", loginCg.body.token);
    const shortPw = await call("POST", "/auth/password-reset/confirm", "", { token: t1, password: "corta" });
    const newPassword = `Nueva-${randomBytes(8).toString("hex")}`;
    const conf = await call("POST", "/auth/password-reset/confirm", "", { token: t1, password: newPassword });
    const meAfter = await call("GET", "/me", loginCg.body.token);
    const loginNew = await call("POST", "/auth/login", "", { email: cg.email, password: newPassword });
    const loginOld = await call("POST", "/auth/login", "", { email: cg.email, password });
    const reuse = await call("POST", "/auth/password-reset/confirm", "", { token: t1, password: `Otra-${randomBytes(8).toString("hex")}` });
    check("P5 a too-short password is refused without spending the link; then the new password works, the old one no longer does",
      shortPw.status === 400 && conf.status === 200 && loginNew.status === 200 && loginOld.status === 401, `short=${shortPw.status} confirm=${conf.status} new=${loginNew.status} old=${loginOld.status}`);
    check("P6 every open session of the account is closed by the change", meBefore.status === 200 && meAfter.status === 401, `${meBefore.status}->${meAfter.status}`);
    check("P7 the link works only once (reuse → 400 INVALID_OR_EXPIRED_RESET_TOKEN)", reuse.status === 400 && reuse.body.error === "INVALID_OR_EXPIRED_RESET_TOKEN", `${reuse.status} ${reuse.body.error}`);

    // ------------------------------------------------------------ expiry, superseded links, garbage
    const famFirst = linkToken(famMails[0].html)!;
    await call("POST", "/auth/password-reset/request", "", { email: fam.email });
    const famSecond = linkToken((await waitMail(fam.email, 2))[1]?.html ?? "")!;
    const oldLink = await call("POST", "/auth/password-reset/confirm", "", { token: famFirst, password: newPassword });
    await q(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id=$1 AND used_at IS NULL`, [fam.userId]);
    const expired = await call("POST", "/auth/password-reset/confirm", "", { token: famSecond, password: newPassword });
    const garbage = await call("POST", "/auth/password-reset/confirm", "", { token: "a".repeat(64), password: newPassword });
    const famLogin = await call("POST", "/auth/login", "", { email: fam.email, password });
    check("P8 asking again cancels the previous link; an expired link and a made-up token are refused the same way; the password is unchanged",
      [oldLink, expired, garbage].every((r) => r.status === 400 && r.body.error === "INVALID_OR_EXPIRED_RESET_TOKEN") && famLogin.status === 200,
      `old=${oldLink.status} expired=${expired.status} garbage=${garbage.status} login=${famLogin.status}`);

    clientIp = "198.51.100.4";
    // ------------------------------------------------------------ every portal
    const portals: string[] = [];
    for (const p of [admin, sup, fam]) {
      const before = mails.filter((m) => m.to === p.email).length;
      await call("POST", "/auth/password-reset/request", "", { email: p.email });
      const link = linkToken((await waitMail(p.email, before + 1))[before]?.html ?? "");
      const pw = `Portal-${randomBytes(8).toString("hex")}`;
      const c = link ? await call("POST", "/auth/password-reset/confirm", "", { token: link, password: pw }) : { status: 0 };
      const l = await call("POST", "/auth/login", "", { email: p.email, password: pw });
      portals.push(`${c.status}/${l.status}`);
    }
    check("P9 works for the agency (administrator, supervisor), caregiver (P5) and family portals", portals.every((x) => x === "200/200"), portals.join(" "));

    clientIp = "198.51.100.5";
    // ------------------------------------------------------------ abuse limits (same for every address)
    const flood = `pr-flood-nobody-${tag}@example.invalid`;
    const floodKnown = floodUser.email;
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < 6; i++) {
      a.push((await call("POST", "/auth/password-reset/request", "", { email: flood })).status);
      b.push((await call("POST", "/auth/password-reset/request", "", { email: floodKnown })).status);
    }
    const stillLogs = await call("POST", "/auth/login", "", { email: floodUser.email, password });
    check("P10 more than 5 requests for one address in 15 min → 429, identical for an account and a non-account; the flood never locks the person's login",
      JSON.stringify(a) === JSON.stringify(b) && a.slice(0, 5).every((s) => s === 200) && a[5] === 429 && stillLogs.status === 200, `${a.join(",")} | ${b.join(",")} login=${stillLogs.status}`);

    // ------------------------------------------------------------ logs
    const everyEmail = [admin, sup, cg, fam, disabled, floodUser].map((p) => p.email).concat(unknown);
    const tokens = mails.map((m) => linkToken(m.html)).filter(Boolean) as string[];
    const leak = logged.some((l) => everyEmail.some((e) => l.toLowerCase().includes(e.toLowerCase())) || tokens.some((t) => l.includes(t)));
    check("P11 no log line contains an e-mail address or a reset token", !leak, `${logged.length} log lines`);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await db.end();
  }

  out("\nPassword recovery by e-mail\n");
  out("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) out(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  out(`\nPassword recovery: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  out(`Password recovery verification failed: ${String((error as Error)?.stack ?? error)}`);
  process.exit(1);
});
