import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const m098 = readFileSync(resolve(process.cwd(), "migrations/098_smartmatch_notifications.sql"), "utf8").replace(/--[^\n]*/g, "");
const service = readFileSync(resolve(process.cwd(), "src/modules/notifications/notifications.service.ts"), "utf8");

// Static guardrails. Behavior: scripts/verifySmartMatchNotifications.ts (25 HTTP checks).
describe("SmartMatch Gate 5: notifications", () => {
  it("derives notifications from the append-only history with an idempotent unique index", () => {
    expect(m098).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_smartmatch_once/);
    expect(m098).toMatch(/AFTER INSERT ON smartmatch_application_events/);
    expect((m098.match(/ON CONFLICT \(user_id, notification_type, related_entity_id\)/g) ?? []).length).toBe(2);
  });

  it("notifies only active administrators of the same agency, never the applicant", () => {
    expect(m098).toContain("om.organization_id = NEW.organization_id");
    expect(m098).toContain("r.code = 'ORGANIZATION_ADMIN'");
    expect(m098).toContain("om.user_id <> NEW.caregiver_user_id");
    expect(m098).not.toMatch(/SUPERVISOR|app_is_superadmin/);
  });

  it("never attaches a patient to a SmartMatch notification", () => {
    expect(m098).not.toMatch(/care_recipient_id\s*,/);
  });

  it("has Spanish summaries for every SmartMatch notification type", () => {
    for (const t of ["SUBMITTED", "APPROVED", "REJECTED", "CLOSED"]) {
      expect(m098).toContain(`SMARTMATCH_APPLICATION_${t}`);
      expect(service).toContain(`case "SMARTMATCH_APPLICATION_${t}"`);
    }
  });
});
