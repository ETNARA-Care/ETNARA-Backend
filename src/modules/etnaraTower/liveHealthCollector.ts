import { sql } from "kysely";
import { withPlatformContext } from "../../context/tenantContext.js";
import type { TowerHealthObservation } from "./observability.js";

const FRONTEND_URL = "https://app.etnaracare.com/";
const timeoutMs = 4000;
/** Live, bounded, read-only probes; no credentials or patient data leave the service. */
export async function collectTowerLiveHealth(
  userId: string,
  checkedAt: string,
  fetcher: typeof fetch = fetch,
): Promise<TowerHealthObservation[]> {
  const backend: TowerHealthObservation = {
    service: "backend", environment: "production", checkedAt,
    health: "healthy", source: "tower-api-request",
    summary: "Authenticated Tower API request succeeded",
  };
  const database: TowerHealthObservation = {
    service: "database", environment: "production", checkedAt,
    health: "unknown", source: "database-readonly-probe",
    summary: "Database probe not verified",
  };
  try {
    await withPlatformContext(userId, async trx => {
      await sql`SELECT 1 AS healthy`.execute(trx);
      return true;
    });
    database.health = "healthy";
    database.summary = "Read-only database query succeeded";
  } catch {
    // Authorization was already checked by the route. Fail closed, no raw errors.
    database.health = "unavailable";
    database.summary = "Read-only database query failed";
  }
  const frontend: TowerHealthObservation = {
    service: "frontend", environment: "production", checkedAt,
    health: "unknown", source: "public-frontend-http-probe",
    summary: "Public frontend availability not verified",
  };
  try {
    const response = await fetcher(FRONTEND_URL, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/html" },
    });
    frontend.health = response.ok ? "healthy" : "degraded";
    frontend.summary = response.ok ? "Public frontend responded successfully" : "Public frontend returned an unsuccessful HTTP status";
    await response.body?.cancel();
  } catch {
    frontend.health = "unknown";
    frontend.summary = "Public frontend HTTP probe could not complete";
  }
  return [backend, database, frontend];
}
