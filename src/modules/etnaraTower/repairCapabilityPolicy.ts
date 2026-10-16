/** Phase 12.9.7: permission boundary for agent-assisted repairs.
 * Planning and PR preparation are distinct from merges and deployments.
 * This module grants no credentials or external side effects.
 */
export type RepairCapability = "diagnose" | "propose_patch" | "prepare_pull_request" | "merge" | "deploy" | "change_secrets" | "modify_patient_data";
const allowed: Readonly<Record<string, readonly RepairCapability[]>> = {
  "technology-4": ["diagnose"], // AXEL — SRE
  "technology-3": ["diagnose"], // ORION — Systems
  "technology-2": ["diagnose", "propose_patch", "prepare_pull_request"], // LEO — Software
};
export function canAgentPrepareRepair(agentId: string, capability: RepairCapability): boolean {
  return Object.hasOwn(allowed, agentId) && allowed[agentId]!.includes(capability);
}
export const REPAIR_AUTONOMOUS_MERGE_ENABLED = false as const;
export const REPAIR_AUTONOMOUS_DEPLOY_ENABLED = false as const;
