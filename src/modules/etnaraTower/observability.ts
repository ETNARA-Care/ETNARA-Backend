/** ETNARA Tower — safe, dependency-free observability contract. */
export type TowerService = "backend" | "frontend" | "database" | "dns";
export type TowerHealth = "healthy" | "degraded" | "unavailable" | "unknown";

export interface TowerHealthObservation {
  service: TowerService;
  environment: string;
  checkedAt: string;
  health: TowerHealth;
  source: string;
  /** Never include tokens, patient data, organization records or raw error logs. */
  summary: string;
}

export interface TowerAlert {
  service: TowerService;
  severity: "warning" | "critical";
  title: string;
  evidenceSource: string;
}

export function deriveTowerAlerts(observations: readonly TowerHealthObservation[]): TowerAlert[] {
  return observations.flatMap((observation): TowerAlert[] => {
    if (observation.health === "healthy" || observation.health === "unknown") return [];
    return [{
      service: observation.service,
      severity: observation.health === "unavailable" ? "critical" : "warning",
      title: observation.health === "unavailable" ? "Service unavailable" : "Service degraded",
      evidenceSource: observation.source,
    }];
  });
}
