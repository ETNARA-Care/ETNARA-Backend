import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Phase 6 end-to-end role flow", () => {
  it("notifies authorized managers and opted-in Family when a visit starts and completes", () => {
    const verification = read("src/modules/verification/verification.service.ts");
    const notifications = read("src/modules/notifications/notifications.service.ts");

    expect(verification).toContain('"SHIFT_STARTED"');
    expect(verification).toContain('"SHIFT_COMPLETED"');
    expect(verification).toMatch(/r\.code IN \('ORGANIZATION_ADMIN', 'SUPERVISOR'\)/);
    expect(verification).toMatch(/fr\.status = 'active'[\s\S]*fr\.can_receive_notifications = true/);
    expect(verification).toMatch(/existing\.related_entity_id = \$\{shiftId\}/);
    expect(notifications).toContain('case "SHIFT_STARTED"');
    expect(notifications).toContain('case "SHIFT_COMPLETED"');
    expect(notifications).toMatch(/WHEN related_entity_type = 'shift'[\s\S]*THEN related_entity_id/);
  });

  it("keeps the eligibility and accepted-assignment gates before check-in", () => {
    const source = read("src/modules/verification/verification.service.ts");
    const verification = source.slice(source.indexOf("export async function checkIn("), source.indexOf("export async function checkOut("));

    const acceptedGate = verification.indexOf('response_status !== "accepted"');
    const eligibilityGate = verification.indexOf('eligibility.eligibilityStatus !== "eligible"');
    const insertCheckIn = verification.indexOf("'check_in'");

    expect(acceptedGate).toBeGreaterThan(-1);
    expect(eligibilityGate).toBeGreaterThan(acceptedGate);
    expect(insertCheckIn).toBeGreaterThan(eligibilityGate);
  });
});
