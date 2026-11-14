/**
 * Comprobación de disponibilidad de la base de datos para el monitor externo.
 * `/health` (healthcheck de Railway) no cambia: responde sin tocar la base.
 * `/health/db` ejecuta `SELECT 1` con un plazo corto y responde 503 si la base no contesta.
 * No expone mensajes de error, nombres de host ni datos: solo «ok» o «unavailable».
 */
export type DbProbe = () => Promise<unknown>;

export async function checkDatabase(probe: DbProbe, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([probe().then(() => true, () => false), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
