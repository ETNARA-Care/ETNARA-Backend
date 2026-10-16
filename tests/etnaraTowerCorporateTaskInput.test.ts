import { describe, expect, it } from "vitest";
import { parseCorporateTaskRequest } from "../src/modules/etnaraTower/corporateTaskInput.js";

const valid = { agentId: "secretariat-1", title: "Prepare agenda", instructions: "Draft next meeting agenda", priority: "normal" };
describe("Tower task request boundary", () => {
  it("accepts a valid assigned agent task", () => {
    expect(parseCorporateTaskRequest(valid)).toEqual(valid);
  });
  it("rejects unknown agents and extra sensitive fields", () => {
    expect(parseCorporateTaskRequest({ ...valid, agentId: "unknown" })).toBeNull();
    expect(parseCorporateTaskRequest({ ...valid, patientId: "123" })).toBeNull();
    expect(parseCorporateTaskRequest({ ...valid, createdByPlatformUserId: "forged" })).toBeNull();
  });
  it("rejects malformed, oversized and untrusted input", () => {
    expect(parseCorporateTaskRequest(null)).toBeNull();
    expect(parseCorporateTaskRequest([])).toBeNull();
    expect(parseCorporateTaskRequest({ ...valid, title: " " })).toBeNull();
    expect(parseCorporateTaskRequest({ ...valid, instructions: "a".repeat(1501) })).toBeNull();
    expect(parseCorporateTaskRequest({ ...valid, priority: "critical" })).toBeNull();
    expect(parseCorporateTaskRequest({ ...valid, instructions: { nested: "bad" } })).toBeNull();
  });
});
