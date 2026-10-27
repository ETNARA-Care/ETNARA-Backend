/**
 * Secure the Casa Demo accounts whose password was published (operator script, one transaction).
 *
 * What it does to every user whose e-mail ends in @demo.etnara.care:
 *   - password_hash -> scrypt hash of 32 random bytes that are never stored or printed,
 *     so the published password (and any other) stops working at once;
 *   - optionally, e-mail -> an alias of a mailbox the owner controls
 *     (DEMO_ALIAS_MAILBOX=owner@gmail.com -> owner+demo-<name>@gmail.com), so the owner can
 *     set a new password with the normal "forgot password" flow; the password never passes
 *     through this script, a chat or a log;
 *   - every open session revoked (revoked_at = now());
 *   - every unused password-reset token marked used;
 *   - one audit_log row per account (previous / new e-mail, no secrets).
 * Casa Demo itself (organization, memberships, roles, residents, shifts, records) is not touched:
 * the script counts those rows before and after inside the same transaction and aborts on any change.
 *
 * Safety:
 *   - SIMULATION BY DEFAULT: everything runs inside a transaction that is rolled back.
 *     Only DEMO_ROTATION_APPLY=yes commits.
 *   - DEMO_EXPECTED_ORGANIZATION_ID (Casa Demo) and DEMO_EXPECTED_COUNT are required: it aborts if
 *     the accounts found differ in number, belong to any other organization, or are ETNARA Central.
 *   - Prints only local parts of e-mails, aliases, counts and true/false checks. Never hashes,
 *     tokens or passwords.
 *   - Self-contained (only `pg` and node:crypto) so it can run as a short-lived Railway function;
 *     the hash format is the one of src/security/password.ts (checked by tests/secureDemoAccounts.test.ts).
 *
 *   DATABASE_URL=<administrative connection>
 *   DEMO_EXPECTED_ORGANIZATION_ID=<Casa Demo id>  DEMO_EXPECTED_COUNT=5
 *   [DEMO_ALIAS_MAILBOX=owner@gmail.com]  [DEMO_ROTATION_APPLY=yes]
 */
import { randomBytes, scrypt } from "node:crypto";
import pg from "pg";

const DEMO_DOMAIN = "demo.etnara.care";
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

export function unusableHash(): Promise<string> {
  const salt = randomBytes(16);
  const secret = randomBytes(32); // never leaves this function
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, 64, { ...SCRYPT, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(`scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString("hex")}$${key.toString("hex")}`)));
}

export function aliasFor(mailbox: string, demoEmail: string): string {
  const m = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(mailbox.trim());
  if (!m) throw new Error("DEMO_ALIAS_MAILBOX is not a plain e-mail address");
  if (m[1].includes("+")) throw new Error("DEMO_ALIAS_MAILBOX must not already contain '+'");
  const local = demoEmail.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return `${m[1].toLowerCase()}+demo-${local}@${m[2].toLowerCase()}`;
}

type Counts = Record<string, number>;

async function orgCounts(c: pg.ClientBase, orgId: string): Promise<Counts> {
  const out: Counts = {};
  for (const t of ["organization_memberships", "user_roles", "organization_worker_memberships", "care_recipients", "shifts", "assignments", "care_events", "family_relationships"]) {
    out[t] = Number((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [orgId])).rows[0].n);
  }
  return out;
}

export async function secureDemoAccounts(c: pg.ClientBase, opts: { orgId: string; expectedCount: number; aliasMailbox?: string; apply: boolean; log?: (s: string) => void }) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const fail = (m: string): never => { throw new Error(`ABORTADO (nada guardado): ${m}`); };
  if (!/^[0-9a-f-]{36}$/i.test(opts.orgId)) fail("DEMO_EXPECTED_ORGANIZATION_ID no es un uuid");
  if (!Number.isInteger(opts.expectedCount) || opts.expectedCount < 1 || opts.expectedCount > 20) fail("DEMO_EXPECTED_COUNT debe estar entre 1 y 20");

  await c.query("BEGIN");
  try {
    const users = (await c.query<{ id: string; email: string; status: string }>(
      `SELECT id, email, status FROM users WHERE lower(email) LIKE '%@' || $1 ORDER BY lower(email) FOR UPDATE`, [DEMO_DOMAIN])).rows;
    if (users.length !== opts.expectedCount) fail(`se esperaban ${opts.expectedCount} cuentas @${DEMO_DOMAIN} y hay ${users.length}`);
    const ids = users.map((u) => u.id);

    const foreign = (await c.query(`SELECT DISTINCT organization_id FROM organization_memberships WHERE user_id = ANY($1) AND organization_id <> $2`, [ids, opts.orgId])).rowCount ?? 0;
    if (foreign > 0) fail(`alguna cuenta demo pertenece a otra organización (${foreign}); no se toca nada`);
    const foreignWork = (await c.query(
      `SELECT 1 FROM organization_worker_memberships owm JOIN workers w ON w.id = owm.worker_id
        WHERE w.user_id = ANY($1) AND owm.organization_id <> $2`, [ids, opts.orgId])).rowCount ?? 0;
    if (foreignWork > 0) fail(`alguna cuenta demo trabaja como cuidadora en otra organización (${foreignWork}); no se toca nada`);
    const foreignFamily = (await c.query(`SELECT 1 FROM family_relationships WHERE user_id = ANY($1) AND organization_id <> $2`, [ids, opts.orgId])).rowCount ?? 0;
    if (foreignFamily > 0) fail(`alguna cuenta demo es familiar en otra organización (${foreignFamily}); no se toca nada`);
    const inOrg = (await c.query(`SELECT 1 FROM organizations WHERE id = $1`, [opts.orgId])).rowCount ?? 0;
    if (inOrg !== 1) fail("la organización indicada no existe");
    const central = (await c.query(`SELECT 1 FROM platform_admins WHERE user_id = ANY($1) AND revoked_at IS NULL`, [ids])).rowCount ?? 0;
    if (central > 0) fail("una cuenta demo es administradora de ETNARA Central; resolverlo aparte");

    const aliases = new Map<string, string>();
    if (opts.aliasMailbox) {
      for (const u of users) aliases.set(u.id, aliasFor(opts.aliasMailbox, u.email));
      const taken = (await c.query(`SELECT 1 FROM users WHERE lower(email) = ANY($1)`, [[...aliases.values()].map((a) => a.toLowerCase())])).rowCount ?? 0;
      if (taken > 0) fail("algún alias ya está en uso por otra cuenta");
    }

    const before = await orgCounts(c, opts.orgId);
    const oldHashes = new Map((await c.query<{ id: string; password_hash: string | null }>(`SELECT id, password_hash FROM users WHERE id = ANY($1)`, [ids])).rows.map((r) => [r.id, r.password_hash]));

    const report: Array<Record<string, unknown>> = [];
    for (const u of users) {
      const alias = aliases.get(u.id);
      const hash = await unusableHash();
      await c.query(`UPDATE users SET password_hash = $2, email = COALESCE($3, email), updated_at = now() WHERE id = $1`, [u.id, hash, alias ?? null]);
      const sessions = (await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id])).rowCount ?? 0;
      const resets = (await c.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id])).rowCount ?? 0;
      await c.query(
        `INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, previous_value, new_value)
         VALUES (NULL, $1, 'DEMO_ACCOUNT_SECURED', 'user', $2, $3::jsonb, $4::jsonb)`,
        [opts.orgId, u.id, JSON.stringify({ email: u.email }), JSON.stringify({ email: alias ?? u.email, passwordReset: true, sessionsRevoked: sessions, reason: "published demo password invalidated" })]);
      report.push({ cuenta: u.email.split("@")[0], estado: u.status, alias: alias ?? "(sin cambio)", sesionesRevocadas: sessions, enlacesAnulados: resets });
    }

    // Checks inside the transaction
    const after = await orgCounts(c, opts.orgId);
    for (const k of Object.keys(before)) if (before[k] !== after[k]) fail(`cambió ${k} de Casa Demo (${before[k]} -> ${after[k]})`);
    const rows = (await c.query<{ id: string; password_hash: string; email: string }>(`SELECT id, password_hash, email FROM users WHERE id = ANY($1)`, [ids])).rows;
    if (rows.some((r) => r.password_hash === oldHashes.get(r.id))) fail("algún hash no cambió");
    const openSessions = Number((await c.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = ANY($1) AND revoked_at IS NULL`, [ids])).rows[0].n);
    if (openSessions !== 0) fail("quedan sesiones abiertas");
    if (opts.aliasMailbox && rows.some((r) => r.email.toLowerCase().endsWith(`@${DEMO_DOMAIN}`))) fail("alguna cuenta conserva el correo demo");

    for (const r of report) log(`CUENTA ${JSON.stringify(r)}`);
    log(`CASA_DEMO_SIN_CAMBIOS ${JSON.stringify(after)}`);
    log(`COMPROBACIONES hashCambiado=true sesionesAbiertas=0 cuentas=${users.length}`);

    if (opts.apply) { await c.query("COMMIT"); log("APLICADO: cambios guardados."); }
    else { await c.query("ROLLBACK"); log("SIMULACIÓN: todo se revirtió; nada se guardó. Para aplicar: DEMO_ROTATION_APPLY=yes"); }
    return { accounts: users.length, report };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL es obligatoria");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await secureDemoAccounts(client, {
      orgId: process.env.DEMO_EXPECTED_ORGANIZATION_ID ?? "",
      expectedCount: Number(process.env.DEMO_EXPECTED_COUNT ?? "0"),
      aliasMailbox: process.env.DEMO_ALIAS_MAILBOX || undefined,
      apply: process.env.DEMO_ROTATION_APPLY === "yes",
    });
  } finally { await client.end(); }
}

if (process.argv[1] && /(^|\/)secureDemoAccounts\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exit(1); });
}
