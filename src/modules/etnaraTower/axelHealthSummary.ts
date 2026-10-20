import type { TowerStatusBoard } from "./statusBoard.js";

/** Produce a bounded operational summary without tenant, patient or credential data. */
export function buildAxelHealthSummary(board: TowerStatusBoard): string {
  const validServices = new Set(["backend", "frontend", "database", "dns"]);
  const validHealth = new Set(["healthy", "degraded", "unavailable", "unknown"]);
  const services = board.services
    .filter(item => validServices.has(item.service))
    .map(item => ({
      service: item.service,
      health: validHealth.has(item.health) ? item.health : "unknown",
      checkedAt: item.checkedAt,
    }));
  return JSON.stringify({
    source: "ETNARA Tower server-side read-only probes",
    generatedAt: board.generatedAt,
    overall: board.overall,
    services,
    limitations: "No direct Railway logs, deployment metrics, or DNS checks are included unless explicitly observed.",
  });
}
