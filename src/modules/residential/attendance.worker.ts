import { sql } from "kysely";
import { db } from "../../config/db.js";
import { env } from "../../config/env.js";

/**
 * 173–175 · Hogares F4: trabajo programado de asistencia (cada 15 min). Idempotente y solo para hogares con
 * HOGAR_PONCHES encendido:
 *   1. crea los códigos que falten (semana actual y siguiente) — la activación depende de la hora, no de este trabajo;
 *   2. avisa a la administración, una vez, cuando un código queda disponible para imprimir;
 *   3. alerta de sesiones abiertas 16 h o más (sin cierre automático).
 * Sin secreto configurado no crea códigos (nunca un código débil).
 */
const INTERVAL_MS = 15 * 60_000;

export async function runAttendanceJob(now = new Date()) {
  const created = env.ATTENDANCE_CODE_SECRET
    ? Number((await sql<{ n: number }>`SELECT app_attendance_ensure_codes(${now.toISOString()}::timestamptz, ${env.ATTENDANCE_CODE_KEY_ID}) AS n`.execute(db)).rows[0]?.n ?? 0)
    : 0;
  const notified = Number((await sql<{ n: number }>`SELECT app_attendance_notify_available(${now.toISOString()}::timestamptz) AS n`.execute(db)).rows[0]?.n ?? 0);
  const longSessions = Number((await sql<{ n: number }>`SELECT app_attendance_scan_long_sessions(${now.toISOString()}::timestamptz) AS n`.execute(db)).rows[0]?.n ?? 0);
  return { created, notified, longSessions };
}

export function startAttendanceWorker(): () => void {
  if (env.ATTENDANCE_JOB !== "on") return () => undefined;
  const tick = async () => {
    try { await runAttendanceJob(); }
    catch (error) {
      const failure = error as { name?: string; code?: string };
      // Sin hogares, personas, códigos ni SQL en el registro.
      console.error("Attendance worker failed", { name: failure.name ?? "Error", code: failure.code ?? "UNKNOWN" });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
