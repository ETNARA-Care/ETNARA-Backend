/**
 * B4 · REVERSIÓN del rol de la supervisora demo (solo si hiciera falta; función temporal, ejecución única).
 *   etnaracare+demo-supervisor@gmail.com en «Cuidado en Casa Demo»: SUPERVISOR -> ORGANIZATION_ADMIN.
 *
 * MODO: REVERSIÓN (aplica) (fijo en el código; la simulación y la aplicación son archivos distintos).
 *   - simulación: hace todo dentro de una transacción y la REVIERTE (ROLLBACK). No guarda nada.
 *   - aplicación: la misma transacción, y solo hace COMMIT si todas las comprobaciones son correctas.
 *
 * El cambio es el bloque DO revisado y probado (b4-supervisora-4-reversion-v2.sql), sin modificar:
 * mismo candado que la app, bloqueo de filas, recuento de filas, auditoría y comprobación final.
 * Alrededor: comprobaciones antes, dentro de la transacción y después, con huellas de lo que NO debe cambiar.
 * Solo imprime verdadero/falso, recuentos y el nombre corto de los roles; nunca correos completos, hashes ni secretos.
 * Límites: 120 s en total, conexión 10 s, sentencia 30 s, bloqueo 5 s, transacción inactiva 60 s.
 * Si se corta antes del COMMIT, PostgreSQL revierte todo.
 */
import pg from "pg@8";

const APPLY = true;
const ORG = "febe519d-3504-4488-a741-d962db40be89";
const EMAIL = "etnaracare+demo-supervisor@gmail.com";
const TAG = "REVERSION";

const CORRECTION_SQL = `DO $$
DECLARE
  c_email     constant text := 'etnaracare+demo-supervisor@gmail.com';
  c_org       constant uuid := 'febe519d-3504-4488-a741-d962db40be89';
  c_org_name  constant text := 'Cuidado en Casa Demo';
  v_user uuid; v_memb uuid; v_rol_sup uuid; v_rol_admin uuid;
  v_ur_sup uuid; v_ur_admin uuid; v_audit uuid;
  v_roles text; v_n int; v_otros_antes text; v_otros_despues text;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(hashtext('team-roles:' || c_org::text));

  v_rol_sup   := (SELECT id FROM roles WHERE code = 'SUPERVISOR');
  v_rol_admin := (SELECT id FROM roles WHERE code = 'ORGANIZATION_ADMIN');
  IF v_rol_sup IS NULL OR v_rol_admin IS NULL THEN RAISE EXCEPTION 'ABORTADO: falta un rol'; END IF;

  PERFORM 1 FROM organizations WHERE id = c_org AND name = c_org_name AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ABORTADO: la agencia no coincide'; END IF;

  v_n := (SELECT count(*) FROM users WHERE lower(email) = c_email);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORTADO: cuentas con ese correo = %', v_n; END IF;
  v_user := (SELECT id FROM users WHERE lower(email) = c_email AND status = 'active' FOR SHARE);
  IF v_user IS NULL THEN RAISE EXCEPTION 'ABORTADO: la cuenta no está activa'; END IF;

  v_memb := (SELECT id FROM organization_memberships
              WHERE user_id = v_user AND organization_id = c_org AND status = 'active' FOR UPDATE);
  IF v_memb IS NULL THEN RAISE EXCEPTION 'ABORTADO: no hay membresía activa en Casa Demo'; END IF;

  PERFORM 1 FROM user_roles WHERE organization_id = c_org FOR UPDATE;
  v_otros_antes := (SELECT string_agg(id::text || ':' || organization_membership_id::text || ':' || role_id::text, ',' ORDER BY id)
                      FROM user_roles WHERE organization_id = c_org AND organization_membership_id <> v_memb);

  v_roles := (SELECT string_agg(r.code, ',' ORDER BY r.code)
                FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.organization_membership_id = v_memb);
  IF v_roles IS DISTINCT FROM 'SUPERVISOR' THEN RAISE EXCEPTION 'ABORTADO: roles actuales = %', coalesce(v_roles, 'ninguno'); END IF;
  v_ur_sup := (SELECT id FROM user_roles
                WHERE organization_membership_id = v_memb AND organization_id = c_org AND role_id = v_rol_sup);

  INSERT INTO user_roles (organization_membership_id, organization_id, role_id)
  VALUES (v_memb, c_org, v_rol_admin) RETURNING id INTO v_ur_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORTADO: filas insertadas = %', v_n; END IF;

  DELETE FROM user_roles WHERE id = v_ur_sup AND organization_membership_id = v_memb AND role_id = v_rol_sup;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORTADO: filas eliminadas = %', v_n; END IF;

  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, previous_value, new_value, device_metadata)
  VALUES (NULL, c_org, 'STAFF_ROLE_CORRECTION_REVERTED', 'organization_membership', v_memb,
          jsonb_build_object('roles', jsonb_build_array('SUPERVISOR'), 'user_role_id', v_ur_sup),
          jsonb_build_object('roles', jsonb_build_array('ORGANIZATION_ADMIN'), 'user_role_id', v_ur_admin),
          jsonb_build_object('via', 'consulta SQL manual en Railway', 'autorizado_por', 'Rafa', 'referencia', 'B4'))
  RETURNING id INTO v_audit;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 OR v_audit IS NULL THEN RAISE EXCEPTION 'ABORTADO: auditoría no registrada'; END IF;

  v_roles := (SELECT string_agg(r.code, ',' ORDER BY r.code)
                FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.organization_membership_id = v_memb);
  IF v_roles IS DISTINCT FROM 'ORGANIZATION_ADMIN' THEN RAISE EXCEPTION 'ABORTADO: roles finales = %', coalesce(v_roles, 'ninguno'); END IF;
  v_otros_despues := (SELECT string_agg(id::text || ':' || organization_membership_id::text || ':' || role_id::text, ',' ORDER BY id)
                        FROM user_roles WHERE organization_id = c_org AND organization_membership_id <> v_memb);
  IF v_otros_despues IS DISTINCT FROM v_otros_antes THEN RAISE EXCEPTION 'ABORTADO: cambiaron roles de otras cuentas'; END IF;

  RAISE NOTICE 'REVERSION_APLICADA membresia=% auditoria=%', v_memb, v_audit;
END $$;`;

setTimeout(() => { console.error(`FIN_${TAG} error: tiempo máximo (120 s) superado; nada guardado si no hubo COMMIT`); process.exit(2); }, 120_000);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL es obligatoria");
if (!new URL(url).hostname.endsWith(".railway.internal")) throw new Error("Solo se permite la red privada de Railway");

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, application_name: "etnara-rol-supervisora-reversion" });
const notices: string[] = [];
client.on("notice", (n) => notices.push(n.message ?? ""));
await client.connect();

// Huella de solo lectura: lo que debe cambiar (roles de la supervisora, auditoría) y lo que NO.
async function snapshot() {
  const r = await client.query(`
    WITH sup AS (
      SELECT om.id FROM organization_memberships om JOIN users u ON u.id = om.user_id
       WHERE lower(u.email) = $2 AND om.organization_id = $1 AND om.status = 'active')
    SELECT
      (SELECT count(*) FROM sup)::int AS membresias_supervisora,
      (SELECT coalesce(string_agg(r.code, ',' ORDER BY r.code), 'ninguno') FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.organization_membership_id IN (SELECT id FROM sup)) AS roles_supervisora,
      (SELECT count(DISTINCT om.id) FROM organization_memberships om
         JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
         JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = $1 AND om.status = 'active' AND u.status = 'active'
          AND r.code = 'ORGANIZATION_ADMIN' AND om.id NOT IN (SELECT id FROM sup))::int AS otras_administradoras,
      (SELECT count(*) FROM audit_log WHERE action = 'STAFF_ROLE_CORRECTION_REVERTED' AND organization_id = $1)::int AS auditoria,
      (SELECT md5(coalesce(string_agg(id || '|' || organization_membership_id || '|' || role_id, ',' ORDER BY id), ''))
         FROM user_roles WHERE organization_membership_id NOT IN (SELECT id FROM sup)) AS otros_roles,
      (SELECT md5(coalesce(string_agg(id || '|' || lower(email) || '|' || status, ',' ORDER BY id), '')) FROM users) AS usuarios,
      (SELECT md5(coalesce(string_agg(id || '|' || user_id || '|' || organization_id || '|' || status, ',' ORDER BY id), ''))
         FROM organization_memberships) AS membresias,
      (SELECT md5(coalesce(string_agg(user_id || '|' || coalesce(revoked_at::text, ''), ',' ORDER BY user_id), '')) FROM platform_admins) AS central,
      (SELECT md5(coalesce(string_agg(id || '|' || status, ',' ORDER BY id), '')) FROM organization_worker_memberships) AS cuidadoras,
      (SELECT md5(coalesce(string_agg(id || '|' || status, ',' ORDER BY id), '')) FROM family_relationships) AS familiares,
      (SELECT md5(coalesce(string_agg(id || '|' || code, ',' ORDER BY id), '')) FROM roles) AS catalogo_roles`,
    [ORG, EMAIL]);
  return r.rows[0];
}
const SAME = ["otros_roles", "usuarios", "membresias", "central", "cuidadoras", "familiares", "catalogo_roles"] as const;

let code = 0;
let committed = false;
try {
  await client.query("SET statement_timeout = '30s'");
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET idle_in_transaction_session_timeout = '60s'");

  const before = await snapshot();
  console.log(`ANTES membresias=${before.membresias_supervisora} roles=${before.roles_supervisora} otras_administradoras=${before.otras_administradoras} auditoria=${before.auditoria}`);
  if (before.membresias_supervisora !== 1 || before.roles_supervisora !== "SUPERVISOR")
    throw new Error("ABORTADO (nada guardado): el estado previo no es el esperado");

  await client.query("BEGIN");
  await client.query(CORRECTION_SQL);
  const inside = await snapshot();
  const insideChecks: Record<string, boolean> = {
    rolEsOrganizationAdmin: inside.roles_supervisora === "ORGANIZATION_ADMIN",
    quedaOtraAdministradora: inside.otras_administradoras >= 1,
    auditoriaMas1: inside.auditoria === before.auditoria + 1,
    ...Object.fromEntries(SAME.map((k) => [`${k}SinCambios`, inside[k] === before[k]])),
  };
  for (const [k, v] of Object.entries(insideChecks)) console.log(`CHEQUEO_TRANSACCION ${k}=${v}`);
  const insideOk = Object.values(insideChecks).every(Boolean);
  if (APPLY && insideOk) { await client.query("COMMIT"); committed = true; }
  else await client.query("ROLLBACK");
  if (!insideOk) throw new Error("ABORTADO (nada guardado): una comprobación dentro de la transacción falló");
  console.log(notices.some((n) => n.startsWith("REVERSION_APLICADA")) ? "BLOQUE_DO REVERSION_APLICADA (dentro de la transacción)" : "BLOQUE_DO sin aviso");

  const after = await snapshot();
  const finalChecks: Record<string, boolean> = APPLY
    ? { rolEsOrganizationAdmin: after.roles_supervisora === "ORGANIZATION_ADMIN", quedaOtraAdministradora: after.otras_administradoras >= 1,
        auditoriaMas1: after.auditoria === before.auditoria + 1, ...Object.fromEntries(SAME.map((k) => [`${k}SinCambios`, after[k] === before[k]])) }
    : { rolSigueOrganizationAdmin: after.roles_supervisora === "ORGANIZATION_ADMIN", auditoriaSinCambios: after.auditoria === before.auditoria,
        ...Object.fromEntries(SAME.map((k) => [`${k}SinCambios`, after[k] === before[k]])) };
  for (const [k, v] of Object.entries(finalChecks)) console.log(`CHEQUEO_FINAL ${k}=${v}`);
  const ok = Object.values(finalChecks).every(Boolean);
  console.log(`RESULTADO_${TAG} ok=${ok} guardado=${committed} roles=${after.roles_supervisora} otras_administradoras=${after.otras_administradoras}`);
  if (!ok) code = 3;
  console.log(`FIN_${TAG} terminado`);
} catch (e) {
  if (!committed) { try { await client.query("ROLLBACK"); } catch { /* sin transacción abierta */ } }
  console.error(`FIN_${TAG} error: ${e instanceof Error ? e.message : "error"} (guardado=${committed})`);
  code = 1;
} finally {
  await client.end();
  process.exit(code);
}
