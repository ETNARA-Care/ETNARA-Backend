import { describe, expect, it } from "vitest";
import { prepareRepairPrDraft } from "./repairPrDraft.js";
const input = { agentId: "technology-2", repository: "ETNARA-Care/ETNARA-Backend", signal: "backend_degraded", branch: "repair/backend-health-01" };
describe("repair PR draft metadata", () => {
  it("prepares a clearly non-executable draft", () => {
    const draft = prepareRepairPrDraft(input);
    expect(draft?.base).toBe("main");
    expect(draft?.readyToCreate).toBe(false);
    expect(draft?.requiresHumanReview).toBe(true);
    expect(draft?.body).toContain("No code changes have been generated or tested.");
  });
  it("rejects unapproved inputs", () => {
    expect(prepareRepairPrDraft({ ...input, agentId: "technology-4" })).toBeNull();
    expect(prepareRepairPrDraft({ ...input, branch: "main" })).toBeNull();
  });
});
