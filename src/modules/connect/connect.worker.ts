import { sql } from "kysely";
import { db } from "../../config/db.js";
import { connectConfig, type ConnectConfig } from "./connect.config.js";
import { signMessage } from "./connect.signing.js";
import type { OrgFacts } from "./connect.service.js";

/**
 * 181 · Aviso inmediato a Connect. Un disparador deja cada cambio de estado (o desvínculo) de una organización
 * vinculada en connect_outbox, en la MISMA transacción. Este repartidor los entrega firmados a Connect:
 *   - en cuanto ocurre (kickConnectOutbox, llamado después de suspender, reactivar o archivar) y
 *   - cada 30 s como respaldo, con reintentos exponenciales (máx. 1 h entre intentos, 7 días de vida).
 * Registra solo conteos. Nunca el cuerpo, la dirección ni la llave.
 */
export type ConnectPoster = (url: string, body: string) => Promise<number>;
export const fetchPoster: ConnectPoster = async (url, body) => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/jose" }, body, signal: AbortSignal.timeout(10_000) });
    return r.status;
  } catch { return 0; }
};

export async function runConnectOutboxTick(cfg: ConnectConfig | null = connectConfig(), post: ConnectPoster = fetchPoster) {
  const result = { delivered: 0, retry: 0 };
  if (!cfg) return result;
  const jobs = (await sql<{ id: string; event_type: string; facts: OrgFacts | null; connect_provider_ref: string | null; payload?: unknown }>`SELECT * FROM public.app_connect_outbox_claim(50)`.execute(db)).rows;
  for (const j of jobs) {
    const body = signMessage(cfg.key, "care.org.event", { event: j.event_type, connectProviderRef: j.connect_provider_ref, facts: j.facts, ...(j.payload ? { transfer: j.payload } : {}) });
    const status = await post(cfg.webhookUrl, body);
    await sql`SELECT public.app_connect_outbox_report(${j.id}::bigint, ${status})`.execute(db);
    if (status >= 200 && status < 300) result.delivered++; else result.retry++;
  }
  return result;
}

let running = false;
let again = false;
/** Entrega inmediata, sin esperar al siguiente ciclo. Nunca lanza ni bloquea a quien la llama.
 *  Si ya hay una entrega en curso, se repite al terminar (el evento nuevo no espera 30 s). */
export function kickConnectOutbox(): void {
  if (!connectConfig()) return;
  if (running) { again = true; return; }
  running = true;
  void runConnectOutboxTick().catch(() => undefined).finally(() => { running = false; if (again) { again = false; kickConnectOutbox(); } });
}

export function startConnectWorker(): void {
  if (!connectConfig()) return;
  setInterval(() => kickConnectOutbox(), 30_000).unref();
  // eslint-disable-next-line no-console
  console.log("CONNECT_WORKER started");
}
