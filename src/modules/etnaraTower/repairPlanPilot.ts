import { canAgentPrepareRepair } from "./repairCapabilityPolicy.js";

export type RepairSignal = "frontend_unavailable" | "database_unavailable" | "backend_degraded";
export interface RepairPlan {
  agentId: "technology-2";
  signal: RepairSignal;
  diagnosis: string;
  suggestedChecks: readonly string[];
  suggestedFiles: readonly string[];
  nextStep: "human_review_required";
  pullRequestCreated: false;
  changesApplied: false;
  deploymentTriggered: false;
}
const playbooks: Readonly<Record<RepairSignal, Omit<RepairPlan, "agentId" | "signal" | "nextStep" | "pullRequestCreated" | "changesApplied" | "deploymentTriggered">>> = {
  frontend_unavailable: {
    diagnosis: "La disponibilidad del portal no pudo verificarse; no implica necesariamente una caída.",
    suggestedChecks: ["Revisar el resultado del despliegue web", "Comprobar DNS y certificado TLS", "Reproducir el error antes de modificar código"],
    suggestedFiles: ["frontend-v23/.github/workflows/deploy.yml"],
  },
  database_unavailable: {
    diagnosis: "La consulta de salud a PostgreSQL falló; la causa aún no está identificada.",
    suggestedChecks: ["Verificar conectividad y registros del servicio", "Revisar el estado de migraciones sin ejecutarlas", "No consultar expedientes de pacientes"],
    suggestedFiles: ["src/modules/etnaraTower/liveHealthCollector.ts"],
  },
  backend_degraded: {
    diagnosis: "Se reportó degradación del backend; se requiere correlacionar registros y métricas.",
    suggestedChecks: ["Revisar errores recientes", "Confirmar la versión desplegada", "Preparar pruebas de regresión antes de cualquier PR"],
    suggestedFiles: ["src/modules/etnaraTower/tower.routes.ts"],
  },
};
export function buildReadOnlyRepairPlan(agentId: string, signal: string): RepairPlan | null {
  if (agentId !== "technology-2" || !canAgentPrepareRepair(agentId, "propose_patch") ||
      !Object.hasOwn(playbooks, signal)) return null;
  const key = signal as RepairSignal;
  return { agentId: "technology-2", signal: key, ...playbooks[key],
    nextStep: "human_review_required", pullRequestCreated: false,
    changesApplied: false, deploymentTriggered: false };
}
