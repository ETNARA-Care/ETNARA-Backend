/**
 * Recovery for the Casa Demo rotation: puts the 5 demo e-mails back (from the DEMO_ACCOUNT_SECURED audit rows).
 * Passwords stay random and sessions stay revoked: it never restores the published password.
 * One transaction; aborts without writing on anything unexpected. Fixed targets; reads only DATABASE_URL.
 */
import pg from "pg@8";

const EXPECTED_ORG = "febe519d-3504-4488-a741-d962db40be89";
const APPROVED_ALIASES = [
  "etnaracare+demo-admin@gmail.com", "etnaracare+demo-carlos@gmail.com", "etnaracare+demo-familia@gmail.com",
  "etnaracare+demo-maria@gmail.com", "etnaracare+demo-supervisor@gmail.com",
];
setTimeout(() => { console.error("FIN_RECUPERACION error: tiempo máximo (120 s) superado"); process.exit(2); }, 120_000);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL es obligatoria");
if (!new URL(url).hostname.endsWith(".railway.internal")) throw new Error("Solo se permite la red privada de Railway");
const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, application_name: "etnara-demo-revert" });
await c.connect();
let code = 0;
try {
  await c.query("SET statement_timeout = '30s'"); await c.query("SET lock_timeout = '5s'"); await c.query("SET idle_in_transaction_session_timeout = '60s'");
  await c.query("BEGIN");
  const fail = (m: string): never => { throw new Error(`ABORTADO (nada guardado): ${m}`); };
  const locked = (await c.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = ANY($1::text[]) ORDER BY id FOR UPDATE`, [APPROVED_ALIASES])).rows.map((r) => r.id);
  const rows = (await c.query<{ id: string; email: string; prev: string }>(
    `SELECT u.id, lower(u.email) AS email,
            (SELECT lower(a.previous_value->>'email') FROM audit_log a
              WHERE a.entity_id::text = u.id::text AND a.action = 'DEMO_ACCOUNT_SECURED' AND a.organization_id = $1
              ORDER BY a.occurred_at DESC LIMIT 1) AS prev
       FROM users u WHERE u.id = ANY($2) ORDER BY u.id`, [EXPECTED_ORG, locked])).rows;
  if (rows.length !== 5) fail(`se esperaban 5 cuentas con alias y auditoría, hay ${rows.length}`);
  if (rows.some((r) => !/^[a-z]+@demo\.etnara\.care$/.test(r.prev ?? ""))) fail("algún correo anterior de la auditoría no es @demo.etnara.care");
  const taken = (await c.query(`SELECT 1 FROM users WHERE lower(email) = ANY($1::text[])`, [rows.map((r) => r.prev)])).rowCount ?? 0;
  if (taken > 0) fail("algún correo @demo.etnara.care ya existe");
  for (const r of rows) {
    await c.query(`UPDATE users SET email = $2, updated_at = now() WHERE id = $1`, [r.id, r.prev]);
    await c.query(`INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, previous_value, new_value)
                   VALUES (NULL, $1, 'DEMO_ACCOUNT_EMAIL_RESTORED', 'user', $2, $3::jsonb, $4::jsonb)`,
      [EXPECTED_ORG, r.id, JSON.stringify({ email: r.email }), JSON.stringify({ email: r.prev, passwordUnchanged: true })]);
    console.log(`CUENTA ${r.prev.split("@")[0]} correo restaurado; contraseña sigue aleatoria`);
  }
  await c.query("COMMIT");
  console.log("FIN_RECUPERACION terminado: 5 correos restaurados");
} catch (e) {
  await c.query("ROLLBACK").catch(() => undefined);
  console.error("FIN_RECUPERACION error:", e instanceof Error ? e.message : "error");
  code = 1;
} finally { await c.end(); process.exit(code); }
