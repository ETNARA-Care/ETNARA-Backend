import { describe, expect, it } from "vitest";
import { validateCorporateTaskAuditEvent } from "../src/modules/etnaraTower/corporateTaskAudit.js";

const base = {
  taskId: "task-1",
  from: "in_review" as const,
  to: "approved" as const,
  actorId: "admin-1",
  actorIsPlatformAdmin: true,
  occurredAt: "2026-10-16T12:00:00.000Z",
};

describe("corporate task audit foundation", () => {
  it("accepts an admin approval transition", () => {
    expect(validateCorporateTaskAuditEvent(base)).toBe(true);
  });
  it("rejects approval without admin authority", () => {
    expect(validateCorporateTaskAuditEvent({ ...base, actorIsPlatformAdmin: false })).toBe(false);
  });
  it("rejects rejection without admin authority", () => {
    expect(validateCorporateTaskAuditEvent({ ...base, from: "submitted", to: "rejected", actorIsPlatformAdmin: false })).toBe(false);
  });
  it("rejects invalid transitions and missing identity", () => {
    expect(validateCorporateTaskAuditEvent({ ...base, from: "draft" })).toBe(false);
    expect(validateCorporateTaskAuditEvent({ ...base, actorId: "" })).toBe(false);
  });
  it("rejects malformed timestamps", () => {
    expect(validateCorporateTaskAuditEvent({ ...base, occurredAt: "not-a-date" })).toBe(false);
  });
});
