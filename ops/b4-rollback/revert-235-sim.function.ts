/**
 * B4 · REVERSIÓN de migraciones del PR #235 (función temporal de Railway, ejecución única).
 *   Migraciones 135 y 133 (bloqueo de horario y corrección con motivo; auditoría y aviso de cambio de horario), en ese orden.
 *
 * MODO: SIMULACIÓN (fijo en el código; simulación y aplicación son archivos distintos).
 *   - simulación: ejecuta la reversión dentro de una transacción y la DESHACE (ROLLBACK). No guarda nada.
 *   - aplicación: la misma transacción; COMMIT solo si todas las comprobaciones son correctas.
 *
 * Requisito previo: el código del backend ya debe estar revertido en `main` y desplegado
 * (el código de #235 llama a funciones que esta reversión elimina).
 * Solo revierte las migraciones que estén aplicadas, en el orden correcto, con los scripts
 * ops/*.rollback.sql del PR (sin sus BEGIN/COMMIT: la transacción la controla esta función).
 * No borra datos: compara recuentos y huellas de las tablas de datos dentro de la misma transacción.
 * Límites: 120 s total, conexión 10 s, sentencia 30 s, bloqueo 5 s, transacción inactiva 60 s.
 */
import pg from "pg@8";

const APPLY = false;
const PR = "#235";
const TAG = APPLY ? "APLICACION" : "SIMULACION";
// En orden de ejecución: la última migración primero.
const STEPS: { migration: string; sql: string }[] = [
  { migration: "135_shift_schedule_lock.sql", sql: `-- Rollback of 135 (bloqueo de horario al comenzar + corrección excepcional).
-- Restores the 107 guard (only «En camino» / «Llegué» lock the schedule) and removes the
-- correction function. The correction history is KEPT: the table is renamed, never
-- dropped (it is an audit record); audit_log rows stay. Then redeploy the previous build
-- (the 135 code calls app_correct_shift_schedule).
CREATE OR REPLACE FUNCTION public.app_shift_update_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  -- Status: a cancelled shift never comes back (it could revive a cancelled
  -- SmartMatch link, journey and alerts); a completed one only re-opens through a
  -- check-in (several caregivers on one shift).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'SHIFT_STATUS_CANCELLED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'completed' AND NEW.status NOT IN ('in_progress', 'cancelled') THEN
      RAISE EXCEPTION 'SHIFT_STATUS_COMPLETED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Non-managers (caregivers) may only change the status.
  IF current_user = 'app_runtime' AND NOT public.app_is_org_manager() AND (
       NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
    OR NEW.room_id IS DISTINCT FROM OLD.room_id
    OR NEW.service_location_id IS DISTINCT FROM OLD.service_location_id
    OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
    OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
    OR NEW.required_role IS DISTINCT FROM OLD.required_role
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'SHIFT_FIELDS_LOCKED' USING ERRCODE = '42501';
  END IF;
  -- Once the caregiver declared the departure or arrived, the visit cannot be
  -- moved (a stale «En camino» would be shown and alerts suppressed): cancel it
  -- and create a new one instead.
  IF (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end)
     AND (EXISTS (SELECT 1 FROM public.shift_journey_events e WHERE e.shift_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.shift_arrivals a WHERE a.shift_id = OLD.id)) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_LOCKED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS app_correct_shift_schedule(uuid, timestamptz, timestamptz, text);
ALTER TABLE shift_schedule_corrections RENAME TO shift_schedule_corrections_rolled_back_135;
ALTER INDEX shift_schedule_corrections_shift RENAME TO shift_schedule_corrections_rolled_back_135_shift;
ALTER TABLE shift_schedule_corrections_rolled_back_135 RENAME CONSTRAINT shift_schedule_corrections_pkey TO shift_schedule_corrections_rolled_back_135_pkey;
DELETE FROM schema_migrations WHERE filename = '135_shift_schedule_lock.sql';
` },
  { migration: "133_shift_reschedule_audit.sql", sql: `-- Rollback of 133 (cambios de horario auditados y avisados). Trigger and function only.
-- The SHIFT_RESCHEDULED audit_log rows and notifications already written stay
-- (append-only history; nothing reads them in a way that breaks without the trigger).
-- Code needs no redeploy: 133 has no application code.
DROP TRIGGER IF EXISTS shifts_reschedule_audit ON shifts;
DROP FUNCTION IF EXISTS app_shift_reschedule_audit();
DELETE FROM schema_migrations WHERE filename = '133_shift_reschedule_audit.sql';
` },
];
// Objetos que deben desaparecer tras revertir cada migración.
const GONE: Record<string, { functions: string[]; triggers: string[]; tables: string[] }> = {"135_shift_schedule_lock.sql": {"functions": ["app_correct_shift_schedule"], "triggers": [], "tables": ["shift_schedule_corrections"]}, "133_shift_reschedule_audit.sql": {"functions": ["app_shift_reschedule_audit"], "triggers": ["shifts_reschedule_audit"], "tables": []}};
const RENAMED_TABLE = ["shift_schedule_corrections", "shift_schedule_corrections_rolled_back_135"]; // [desde, hacia] o null
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
