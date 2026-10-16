import { railwayServiceObservation } from "./providerSnapshots.js";
import type { TowerHealthObservation, TowerService } from "./observability.js";

/** Only sanitized infrastructure fields. Never pass Railway raw logs, variables or credentials. */
export interface RailwayTowerService {
  serviceId: string;
  state: string;
  serviceName: string;
  statusText?: string;
}
export interface RailwayTowerEnvironment {
  services: readonly RailwayTowerService[];
}
export interface RailwayTowerServiceMapping {
  backend: string;
  database: string;
}
const unknown = (service: TowerService, at: string): TowerHealthObservation => ({
  service, environment: "production", checkedAt: at,
  health: "unknown", source: "railway-environment-status", summary: "Service status unavailable",
});
/** Converts read-only environment status data to Tower observations without exposing tenant data. */
export function collectRailwayEnvironmentObservations(
  environment: RailwayTowerEnvironment | null,
  mapping: RailwayTowerServiceMapping,
  checkedAt: string,
): TowerHealthObservation[] {
  return (["backend", "database"] as const).map(service => {
    const targetId = mapping[service];
    const snapshot = targetId && environment?.services.find(s => s.serviceId === targetId);
    if (!snapshot) return unknown(service, checkedAt);
    const state = snapshot.state.toLowerCase();
    const observation = railwayServiceObservation({ name: snapshot.serviceName, state, deploymentStatus: null }, checkedAt);
    return { ...observation, service, source: "railway-environment-status" };
  });
}
