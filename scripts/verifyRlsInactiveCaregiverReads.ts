/**
 * RLS G4 (migración 137): una cuidadora DESACTIVADA en una agencia, vista desde la base con el rol
 * restringido app_runtime (sin código de la aplicación en medio).
 *
 * Para cada actor se fija el contexto (app.current_user_id / app.current_org_id), se cambia a
 * app_runtime y se cuenta lo que ve de la cuidadora: su perfil (workers), sus credenciales, sus
 * documentos y las versiones de esos documentos. También se intenta escribir.
 *
 *   - administradora y supervisora de la agencia donde está INACTIVA: leen todo; no escriben nada;
 *   - otra cuidadora de esa agencia, la familia y la administradora de una agencia sin relación: 0;
 *   - agencia donde sigue ACTIVA: lee (como antes);
 *   - la propia cuidadora: sus propias filas (como antes);
 *   - sin la 137, la administradora de la agencia donde está inactiva vería 0 (control).
 *
 * Datos sintéticos; solo bases desechables.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> npx tsx scripts/verifyRlsInactiveCaregiverReads.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows;
  const tag = randomUUID().slice(0, 8);

  const org = async (n: string) => (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`G4 ${n} ${tag}`]))[0].id as string;
  const A = await org("A"), B = await org("B"), C = await org("C");
  const user = async (k: string) => (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,'x','active') RETURNING id`, [`g4-${k}-${tag}@example.invalid`]))[0].id as string;
  const member = async (u: string, o: string, role: string) => {
    const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [u, o]))[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, o, role]);
  };
  const actors: Record<string, { user: string; org: string }> = {};
  for (const [k, o, role] of [["adminA", A, "ORGANIZATION_ADMIN"], ["supA", A, "SUPERVISOR"], ["famA", A, "FAMILY"], ["adminB", B, "ORGANIZATION_ADMIN"], ["adminC", C, "ORGANIZATION_ADMIN"]] as const) {
    const u = await user(k); await member(u, o, role); actors[k] = { user: u, org: o };
  }
  // Another caregiver of A (active).
  const other = await user("otra"); await member(other, A, "WORKER");
  const otherW = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Otra') RETURNING id`, [other]))[0].id;
  await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver')`, [otherW, A]);
  actors.otraA = { user: other, org: A };

  // The caregiver: INACTIVE in A, ACTIVE in B, with a credential, its document and a version.
  const d = await user("d"); await member(d, A, "WORKER"); await member(d, B, "WORKER");
  const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [d, `Desactivada ${tag}`]))[0].id as string;
  await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role,ended_at) VALUES ($1,$2,'inactive','caregiver',now())`, [w, A]);
  await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver')`, [w, B]);
  const type = (await q(`SELECT id FROM credential_types ORDER BY code LIMIT 1`))[0].id;
  const cred = (await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status) VALUES ($1,$2,'government','active') RETURNING id`, [w, type]))[0].id;
  const file = (await q(`INSERT INTO stored_files (scope_type,owner_worker_id,storage_key,content_type,original_filename,size_bytes,uploaded_by_user_id)
                         VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','licencia.pdf',1024,$3) RETURNING id`, [w, `synthetic/${randomUUID()}.pdf`, d]))[0].id;
  const doc = (await q(`INSERT INTO documents (worker_id,credential_type_id,file_id) VALUES ($1,$2,$3) RETURNING id`, [w, type, file]))[0].id;
  await q(`UPDATE credentials SET document_id=$1 WHERE id=$2`, [doc, cred]);
  const hasVersion = Number((await q(`SELECT count(*) FROM document_versions WHERE document_id=$1`, [doc]))[0].count) > 0
    || (await q(`INSERT INTO document_versions (document_id,file_id,version) VALUES ($1,$2,1) RETURNING id`, [doc, file]).then(() => true, () => false));
  actors.dA = { user: d, org: A };
  const before = (await q(`SELECT (SELECT display_name FROM workers WHERE id=$1) n, (SELECT status FROM credentials WHERE id=$2) s, (SELECT count(*) FROM credentials WHERE worker_id=$1) c`, [w, cred]))[0];

  // Everything below runs as app_runtime inside a transaction that is rolled back.
  async function as<T>(k: string, fn: () => Promise<T>): Promise<T> {
    await q("BEGIN");
    try {
      await q(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [actors[k].user, actors[k].org]);
      await q("SET LOCAL ROLE app_runtime");
      return await fn();
    } finally { await q("ROLLBACK"); }
  }
  const sees = (k: string) => as(k, async () => (await q(`SELECT
      (SELECT count(*) FROM workers WHERE id=$1)::int AS perfil,
      (SELECT count(*) FROM credentials WHERE worker_id=$1)::int AS credenciales,
      (SELECT count(*) FROM documents WHERE worker_id=$1)::int AS documentos,
      (SELECT count(*) FROM document_versions WHERE document_id=$2)::int AS versiones`, [w, doc]))[0]);
  const want = (v: any, n: number) => v.perfil === n && v.credenciales === n && v.documentos === n && (!hasVersion || v.versiones === n);

  for (const k of ["adminA", "supA"]) {
    const v = await sees(k);
    check(`${k}: lee perfil, credencial, documento y versión de la inactiva`, want(v, 1), JSON.stringify(v));
    // Each attempt in its own savepoint: a rejected write (42501) must not hide the next one.
    const attempt = async (sqlText: string, p: unknown[]) => {
      await q("SAVEPOINT a");
      try { const r = await q(sqlText, p); await q("RELEASE SAVEPOINT a"); return `filas=${r.length}`; }
      catch (e: any) { await q("ROLLBACK TO SAVEPOINT a"); return e.code as string; }
    };
    const upd = await as(k, async () => ({
      perfil: await attempt(`UPDATE workers SET display_name='cambiado' WHERE id=$1 RETURNING id`, [w]),
      cambiar: await attempt(`UPDATE credentials SET status='revoked' WHERE id=$1 RETURNING id`, [cred]),
      insertar: await attempt(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status) VALUES ($1,$2,'government','active') RETURNING id`, [w, type]),
      borrar: await attempt(`DELETE FROM credentials WHERE id=$1 RETURNING id`, [cred]),
      documento: await attempt(`UPDATE documents SET status=status WHERE id=$1 RETURNING id`, [doc]),
      // Write paths that a new SELECT policy could combine with (RETURNING, row locks, inserts).
      borrarPerfil: await attempt(`DELETE FROM workers WHERE id=$1 RETURNING id`, [w]),
      bloquearPerfil: await attempt(`SELECT id FROM workers WHERE id=$1 FOR UPDATE`, [w]),
      bloquearCredencial: await attempt(`SELECT id FROM credentials WHERE id=$1 FOR UPDATE`, [cred]),
      nuevoDocumento: await attempt(`INSERT INTO documents (worker_id,credential_type_id,file_id) VALUES ($1,$2,$3) RETURNING id`, [w, type, file]),
      borrarDocumento: await attempt(`DELETE FROM documents WHERE id=$1 RETURNING id`, [doc]),
      nuevaVersion: await attempt(`INSERT INTO document_versions (document_id,file_id,version) VALUES ($1,$2,99) RETURNING id`, [doc, file]),
      cambiarVersion: await attempt(`UPDATE document_versions SET version=version WHERE document_id=$1 RETURNING id`, [doc]),
      borrarVersion: await attempt(`DELETE FROM document_versions WHERE document_id=$1 RETURNING id`, [doc]),
    }));
    const blocked = (r: string) => r === "filas=0" || r === "42501";
    check(`${k}: no escribe nada de la inactiva (perfil, credenciales, documentos)`, Object.values(upd).every(blocked), JSON.stringify(upd));
  }
  // The helper itself, outside its intended context (SECURITY DEFINER must not leak across agencies).
  const fn = async (k: string | null, org?: string) => {
    await q("BEGIN");
    try {
      if (k) await q(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [actors[k].user, org ?? actors[k].org]);
      await q("SET LOCAL ROLE app_runtime");
      return (await q(`SELECT public.app_manager_reads_org_worker($1) AS ok`, [w]))[0].ok as boolean;
    } finally { await q("ROLLBACK"); }
  };
  check("función: administradora de A en su agencia → verdadero", (await fn("adminA")) === true);
  check("función: sin contexto → falso", (await fn(null)) === false);
  check("función: administradora de C (sin relación) → falso", (await fn("adminC")) === false);
  check("función: administradora de C fingiendo la agencia A → falso (no es gestora allí)", (await fn("adminC", A)) === false);
  check("función: otra cuidadora de A → falso", (await fn("otraA")) === false);
  check("función: familia de A → falso", (await fn("famA")) === false);
  const execPublic = (await q(`SELECT has_function_privilege('pg_monitor','public.app_manager_reads_org_worker(uuid)','EXECUTE') AS p`))[0].p;
  const def = (await q(`SELECT prosecdef, proconfig::text AS cfg, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname='app_manager_reads_org_worker'`))[0];
  check("función: sin EXECUTE para PUBLIC; search_path fijo", execPublic === false && def.prosecdef === true && /search_path=pg_catalog, public/.test(def.cfg), JSON.stringify(def));
  const newPolicies = await q(`SELECT tablename, cmd, permissive FROM pg_policies WHERE policyname LIKE '%_manager_read_any_status'`);
  check("las 4 políticas nuevas son solo SELECT y permisivas", newPolicies.length === 4 && newPolicies.every((r: any) => r.cmd === "SELECT" && r.permissive === "PERMISSIVE"), JSON.stringify(newPolicies));

  for (const k of ["otraA", "famA", "adminC"]) {
    const v = await sees(k);
    check(`${k}: no ve nada de la inactiva`, want(v, 0), JSON.stringify(v));
  }
  check("adminB (agencia donde sigue activa): lee, como antes", want(await sees("adminB"), 1));
  const own = await sees("dA");
  check("la propia cuidadora: ve sus filas, como antes", own.perfil === 1 && own.credenciales === 1, JSON.stringify(own));

  // Control: without the 137 policies the agency loses her (the gap).
  await q("BEGIN");
  for (const t of ["workers", "credentials", "documents", "document_versions"]) await q(`DROP POLICY IF EXISTS ${t}_manager_read_any_status ON ${t}`);
  await q(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [actors.adminA.user, A]);
  await q("SET LOCAL ROLE app_runtime");
  const ctl = (await q(`SELECT (SELECT count(*) FROM workers WHERE id=$1)::int p, (SELECT count(*) FROM credentials WHERE worker_id=$1)::int c`, [w]))[0];
  await q("ROLLBACK");
  check("control sin la 137: la administradora no la ve (la brecha)", ctl.p === 0 && ctl.c === 0, JSON.stringify(ctl));
  const restored = Number((await q(`SELECT count(*) FROM pg_policies WHERE policyname LIKE '%_manager_read_any_status'`))[0].count);
  check("control revertido: las 4 políticas siguen", restored === 4, `${restored}`);

  const after = (await q(`SELECT (SELECT display_name FROM workers WHERE id=$1) n, (SELECT status FROM credentials WHERE id=$2) s, (SELECT count(*) FROM credentials WHERE worker_id=$1) c`, [w, cred]))[0];
  check("ningún dato cambió", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  console.log(`\nRLS_INACTIVE_CAREGIVER_READS ${results.length - failed.length}/${results.length}${hasVersion ? "" : " (sin versión de documento en este esquema)"}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
