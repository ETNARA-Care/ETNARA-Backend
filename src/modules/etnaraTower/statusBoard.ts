import { deriveTowerAlerts } from "./observability.js";
import type { TowerAlert, TowerHealthObservation, TowerService } from "./observability.js";

export interface TowerStatusBoard {
  generatedAt: string;
  overall: "healthy" | "attention" | "critical" | "unknown";
  services: Array<{ service: TowerService; health: TowerHealthObservation["health"]; summary: string; checkedAt: string }>;
  alerts: TowerAlert[];
  totalObservations: number;
}
const SERVICES: readonly TowerService[] = ["backend", "frontend", "database", "dns"];
/** Deterministic, sanitized snapshot. No network, credentials, patient data, or side effects. */
export function buildTowerStatusBoard(
  observations: readonly TowerHealthObservation[],
  generatedAt: string,
): TowerStatusBoard {
  const services = SERVICES.map(service => {
    const latest = observations.filter(item => item.service === service)
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
    return { service, health: latest?.health ?? "unknown", summary: latest?.summary ?? "No observations available", checkedAt: latest?.checkedAt ?? generatedAt };
  });
  const latestObservations = SERVICES.flatMap(service => {
    const latest = observations.filter(item => item.service === service)
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
    return latest ? [latest] : [];
  });
  const alerts = deriveTowerAlerts(latestObservations);
  const overall = alerts.some(a => a.severity === "critical") ? "critical"
    : alerts.length ? "attention"
    : services.every(s => s.health === "healthy") ? "healthy" : "unknown";
  return { generatedAt, overall, services, alerts, totalObservations: observations.length };
}
