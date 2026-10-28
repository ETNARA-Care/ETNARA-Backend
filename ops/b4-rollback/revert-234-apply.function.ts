/**
 * B4 · REVERSIÓN de migraciones del PR #234 (función temporal de Railway, ejecución única).
 *   Migraciones 134 y 132 (asignación pendiente con datos mínimos; ventana de acceso de cuidadoras), en ese orden.
 *
 * MODO: APLICACIÓN (fijo en el código; simulación y aplicación son archivos distintos).
 *   - simulación: ejecuta la reversión dentro de una transacción y la DESHACE (ROLLBACK). No guarda nada.
 *   - aplicación: la misma transacción; COMMIT solo si todas las comprobaciones son correctas.
 *
 * Requisito previo: el código del backend ya debe estar revertido en `main` y desplegado
 * (el código de #234 llama a funciones que esta reversión elimina).
 * Solo revierte las migraciones que estén aplicadas, en el orden correcto, con los scripts
 * ops/*.rollback.sql del PR (sin sus BEGIN/COMMIT: la transacción la controla esta función).
 * No borra datos: compara recuentos y huellas de las tablas de datos dentro de la misma transacción.
 * Límites: 120 s total, conexión 10 s, sentencia 30 s, bloqueo 5 s, transacción inactiva 60 s.
 */
import pg from "pg@8";

const APPLY = true;
const PR = "#234";
const TAG = APPLY ? "APLICACION" : "SIMULACION";
// En orden de ejecución: la última migración primero.
const STEPS: { migration: string; sql: string }[] = [
  { migration: "134_pending_assignment_minimal.sql", sql: `-- Rollback of 134 (asignación pendiente = datos mínimos). Functions and one policy only;
-- no data changes. Restores the pre-134 rules (pending assignments see the full record,
-- the care plan and the private instructions again). Then redeploy the previous backend
-- build (GET /me/shifts of 134 calls app_my_shift_preview).
CREATE OR REPLACE FUNCTION public.app_worker_has_recipient_assignment(p_care_recipient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm ON a.organization_worker_membership_id = owm.id
        JOIN shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
        WHERE a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
          AND a.response_status IN ('pending', 'accepted')
          AND s.status IN ('unassigned', 'confirmed', 'in_progress')
          AND (
            s.scheduled_end > now()
            OR (
              a.response_status = 'accepted'
              AND s.status = 'in_progress'
              AND EXISTS (
                SELECT 1
                FROM verification_events check_in
                WHERE check_in.organization_id = a.organization_id
                  AND check_in.shift_id = a.shift_id
                  AND check_in.organization_worker_membership_id = a.organization_worker_membership_id
                  AND check_in.event_type = 'check_in'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM verification_events check_out
                    WHERE check_out.organization_id = check_in.organization_id
                      AND check_out.shift_id = check_in.shift_id
                      AND check_out.organization_worker_membership_id = check_in.organization_worker_membership_id
                      AND check_out.event_type = 'check_out'
                      AND check_out.occurred_at > check_in.occurred_at
                  )
              )
            )
          )
          AND (
            a.care_recipient_id = p_care_recipient_id
            OR s.care_recipient_id = p_care_recipient_id
            OR (s.room_id IS NOT NULL AND s.room_id = app_recipient_room_id(p_care_recipient_id))
          )
    );
$function$;

DROP POLICY IF EXISTS shift_private_instructions_assigned_worker_read ON shift_private_instructions;
CREATE POLICY shift_private_instructions_assigned_worker_read ON shift_private_instructions
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_worker_has_shift_assignment(shift_id));

DROP FUNCTION IF EXISTS app_my_shift_preview(uuid);
DELETE FROM schema_migrations WHERE filename = '134_pending_assignment_minimal.sql';
` },
  { migration: "132_caregiver_access_window.sql", sql: `-- Rollback of 132 (ventana de acceso de las cuidadoras). Functions and policies only;
-- no data is changed or removed. Restores the exact rules of 038 (messaging) and 100
-- (service addresses): pending assignments and past caregivers regain access.
-- If 134 is applied, roll back 134 FIRST (its policy uses app_worker_confirmed_shift_assignment).
-- Run as the migrations superuser, then redeploy the previous backend build
-- (the code of 132 calls app_user_can_message_recipient and app_worker_confirmed_shift_assignment).
DROP POLICY IF EXISTS message_threads_read ON message_threads;
CREATE POLICY message_threads_read ON message_threads
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM message_thread_participants mtp
            WHERE mtp.message_thread_id = message_threads.id
              AND mtp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
        AND (
            app_is_org_manager()
            OR care_recipient_id IS NULL
            OR app_user_authorized_for_recipient(
                NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                message_threads.organization_id,
                message_threads.care_recipient_id
            )
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS message_threads_create ON message_threads;
CREATE POLICY message_threads_create ON message_threads
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR (
                care_recipient_id IS NOT NULL
                AND app_user_authorized_for_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    message_threads.organization_id,
                    message_threads.care_recipient_id
                )
            )
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS message_thread_participants_write ON message_thread_participants;
CREATE POLICY message_thread_participants_write ON message_thread_participants
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR (
                user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                AND app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id) IS NOT NULL
                AND app_user_authorized_for_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
            )
            OR (
                app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id) IS NOT NULL
                AND app_user_authorized_for_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
                AND app_user_authorized_for_recipient(
                    message_thread_participants.user_id,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
            )
        )
        OR app_is_superadmin()
    );


CREATE OR REPLACE FUNCTION app_worker_can_read_service_location(
  p_location_id uuid, p_recipient_id uuid, p_is_primary boolean, p_archived_at timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND s.care_recipient_id = p_recipient_id
      AND (s.service_location_id = p_location_id
           OR (s.service_location_id IS NULL AND p_is_primary AND p_archived_at IS NULL))
      AND public.app_worker_has_shift_assignment(s.id)
  );
$$;
REVOKE ALL ON FUNCTION app_worker_can_read_service_location(uuid, uuid, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_worker_can_read_service_location(uuid, uuid, boolean, timestamptz) TO app_runtime;

DROP FUNCTION IF EXISTS app_my_message_recipients();
DROP FUNCTION IF EXISTS app_user_can_message_recipient(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app_worker_messaging_window(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app_worker_confirmed_shift_assignment(uuid);
DELETE FROM schema_migrations WHERE filename = '132_caregiver_access_window.sql';
` },
];
// Objetos que deben desaparecer tras revertir cada migración.
const GONE: Record<string, { functions: string[]; triggers: string[]; tables: string[] }> = {"134_pending_assignment_minimal.sql": {"functions": ["app_my_shift_preview"], "triggers": [], "tables": []}, "132_caregiver_access_window.sql": {"functions": ["app_my_message_recipients", "app_user_can_message_recipient", "app_worker_messaging_window", "app_worker_confirmed_shift_assignment"], "triggers": [], "tables": []}};
const RENAMED_TABLE = null; // [desde, hacia] o null
const DATA_TABLES = ["audit_log", "notifications", "message_threads", "message_thread_participants", "messages", "shifts",
  "assignments", "shift_private_instructions", "care_recipients", "care_recipient_service_locations", "organization_worker_memberships", "user_roles"];

setTimeout(() => { console.error(`FIN_REVERSION_${TAG} error: tiempo máximo (120 s) superado; nada guardado si no hubo COMMIT`); process.exit(2); }, 120_000);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL es obligatoria");
if (!new URL(url).hostname.endsWith(".railway.internal")) throw new Error("Solo se permite la red privada de Railway");
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, application_name: `etnara-reversion-${PR}` });
await client.connect();
const one = async (q: string, p: unknown[] = []) => (await client.query(q, p)).rows[0];

async function dataSnapshot() {
  const out: Record<string, string> = {};
  for (const t of DATA_TABLES) {
    if (!(await one(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${t}`])).e) continue;
    out[t] = (await one(`SELECT count(*)::text || ':' || md5(coalesce(string_agg(md5(x::text), ',' ORDER BY md5(x::text)), '')) AS h FROM public.${t} x`)).h;
  }
  if (RENAMED_TABLE) {
    for (const t of RENAMED_TABLE) {
      if ((await one(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${t}`])).e)
        out.historial_correcciones = (await one(`SELECT count(*)::text || ':' || md5(coalesce(string_agg(md5(x::text), ',' ORDER BY md5(x::text)), '')) AS h FROM public.${t} x`)).h;
    }
  }
  return out;
}
async function applied(): Promise<string[]> {
  return (await client.query(`SELECT filename FROM schema_migrations WHERE filename = ANY($1) ORDER BY filename`, [STEPS.map((s) => s.migration)])).rows.map((r) => r.filename);
}
async function structure() {
  const r: Record<string, boolean> = {};
  for (const s of STEPS) {
    const g = GONE[s.migration];
    r[`${s.migration}:funciones`] = Number((await one(`SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1)`, [g.functions])).n) === 0;
    r[`${s.migration}:disparadores`] = Number((await one(`SELECT count(*) AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1)`, [g.triggers])).n) === 0;
    r[`${s.migration}:tablas`] = Number((await one(`SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [g.tables])).n) === 0;
  }
  return r;
}

let code = 0;
let committed = false;
try {
  await client.query("SET statement_timeout = '30s'");
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET idle_in_transaction_session_timeout = '60s'");

  const before = await applied();
  console.log(`ANTES aplicadas=${before.join(",") || "ninguna"}`);
  if (before.length === 0) throw new Error("ABORTADO (nada guardado): no hay migraciones de este PR aplicadas");
  if (RENAMED_TABLE && before.includes(STEPS[0].migration)
      && (await one(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${RENAMED_TABLE[1]}`])).e)
    throw new Error(`ABORTADO (nada guardado): ya existe ${RENAMED_TABLE[1]} de una reversión anterior; renombrarla antes`);
  // Foto fija de la transacción (REPEATABLE READ): el tráfico en vivo no altera la comparación de datos.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  const dataBefore = await dataSnapshot();
  for (const s of STEPS) {
    if (!before.includes(s.migration)) { console.log(`PASO ${s.migration} omitido (no aplicada)`); continue; }
    await client.query(s.sql);
    console.log(`PASO ${s.migration} revertida (dentro de la transacción)`);
  }
  const inside = { left: await applied(), structure: await structure(), data: await dataSnapshot() };
  const insideChecks: Record<string, boolean> = {
    migracionesRetiradas: inside.left.length === 0,
    ...Object.fromEntries(Object.entries(inside.structure).filter(([k]) => before.includes(k.split(":")[0])).map(([k, v]) => [`objetosEliminados ${k}`, v])),
    ...Object.fromEntries(Object.keys(dataBefore).map((k) => [`datosIntactos ${k}`, inside.data[k] === dataBefore[k]])),
  };
  for (const [k, v] of Object.entries(insideChecks)) console.log(`CHEQUEO_TRANSACCION ${k}=${v}`);
  const insideOk = Object.values(insideChecks).every(Boolean);
  if (APPLY && insideOk) { await client.query("COMMIT"); committed = true; } else await client.query("ROLLBACK");
  if (!insideOk) throw new Error("ABORTADO (nada guardado): una comprobación dentro de la transacción falló");

  // Después (solo lectura). Los datos ya se compararon dentro de la transacción.
  const after = { left: await applied(), structure: await structure() };
  const finalChecks: Record<string, boolean> = APPLY
    ? { migracionesRetiradas: after.left.length === 0,
        ...Object.fromEntries(Object.entries(after.structure).filter(([k]) => before.includes(k.split(":")[0])).map(([k, v]) => [`objetosEliminados ${k}`, v])) }
    : { siguenAplicadas: after.left.join(",") === before.join(",") };
  for (const [k, v] of Object.entries(finalChecks)) console.log(`CHEQUEO_FINAL ${k}=${v}`);
  const ok = Object.values(finalChecks).every(Boolean);
  console.log(`RESULTADO_REVERSION_${TAG} pr=${PR} ok=${ok} guardado=${committed} aplicadas_ahora=${after.left.join(",") || "ninguna"}`);
  if (!ok) code = 3;
  console.log(`FIN_REVERSION_${TAG} terminado`);
} catch (e) {
  if (!committed) { try { await client.query("ROLLBACK"); } catch { /* sin transacción abierta */ } }
  console.error(`FIN_REVERSION_${TAG} error: ${e instanceof Error ? e.message : "error"} (guardado=${committed})`);
  code = 1;
} finally {
  await client.end();
  process.exit(code);
}
