import { describe, expect, it } from "vitest";
import { nextSmartMatchApplicationStatus as transition } from "../src/modules/smartmatch/smartmatch.applicationState.js";

describe("SmartMatch application decisions", () => {
  it("requires an agency manager to approve or reject", () => {
    expect(transition("PENDING", "APPROVE", false, true)).toBeNull();
    expect(transition("PENDING", "REJECT", false, false)).toBeNull();
    expect(transition("PENDING", "APPROVE", true, false)).toBe("APPROVED");
    expect(transition("PENDING", "REJECT", true, false)).toBe("REJECTED");
  });
  it("allows only the applicant to withdraw", () => {
    expect(transition("PENDING", "WITHDRAW", true, false)).toBeNull();
    expect(transition("PENDING", "WITHDRAW", false, true)).toBe("WITHDRAWN");
  });
  it("does not allow repeated or conflicting decisions", () => {
    expect(transition("APPROVED", "APPROVE", true, false)).toBeNull();
    expect(transition("REJECTED", "APPROVE", true, false)).toBeNull();
    expect(transition("WITHDRAWN", "APPROVE", true, false)).toBeNull();
  });
});
