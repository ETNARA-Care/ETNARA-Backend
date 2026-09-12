import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 5.4 actionable notifications and shift cancellation", () => {
  it("resolves an assignment notification to a shift without bypassing notification ownership", () => {
    const migration = read("migrations/044_actionable_assignment_notifications.sql");
    const service = read("src/modules/notifications/notifications.service.ts");

    expect(migration).toMatch(/n\.user_id\s*=\s*NULLIF\(current_setting\('app\.current_user_id'/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION app_notification_assignment_shift_id\(uuid\) FROM PUBLIC/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION app_notification_assignment_shift_id\(uuid\) TO app_runtime/);
    expect(service).toContain("app_notification_assignment_shift_id(id)");
    expect(service).toContain("careRecipientId: r.care_recipient_id");
    expect(service).toContain("shiftId: r.shift_id");
  });

  it("only cancels future shifts that have not started and preserves their rows", () => {
    const service = read("src/modules/scheduling/scheduling.service.ts");
    const routes = read("src/modules/scheduling/scheduling.routes.ts");

    expect(service).toMatch(/status IN \('unassigned', 'confirmed'\)/);
    expect(service).toMatch(/scheduled_start > now\(\)/);
    expect(service).not.toMatch(/DELETE FROM shifts/);
    expect(routes).toContain('res.status(409).json({ error: "SHIFT_CANNOT_BE_CANCELLED" })');
  });
});
