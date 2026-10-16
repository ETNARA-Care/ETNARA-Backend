import { validateCorporateTaskRequest, type CorporateTaskRequest } from "./corporateTaskPolicy.js";

/** Parse unknown HTTP payloads without trusting caller-provided TypeScript types. */
export function parseCorporateTaskRequest(value: unknown): CorporateTaskRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.agentId !== "string" || typeof input.title !== "string" ||
      typeof input.instructions !== "string" || typeof input.priority !== "string") return null;
  if (Object.keys(input).some(key => !["agentId", "title", "instructions", "priority"].includes(key))) return null;
  if (!["low", "normal", "high"].includes(input.priority)) return null;
  const request: CorporateTaskRequest = {
    agentId: input.agentId,
    title: input.title.trim(),
    instructions: input.instructions.trim(),
    priority: input.priority as CorporateTaskRequest["priority"],
  };
  return validateCorporateTaskRequest(request) ? request : null;
}
