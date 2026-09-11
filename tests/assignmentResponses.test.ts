import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("Assignment response contracts", () => {
  it("applies pending migrations before the Railway server starts", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.start).toMatch(/^npm run bootstrap:staging && /);
  });

  it("stores one explicit pending, accepted, or rejected response", () => {
    const migration = read("migrations/042_assignment_responses.sql");
    const service = read("src/modules/assignments/assignments.service.ts");
    expect(migration).toMatch(/response_status IN \('pending', 'accepted', 'rejected'\)/);
    expect(migration).toMatch(/assignments_active_shift_membership_unique/);
    expect(migration).toMatch(/WHERE response_status IN \('pending', 'accepted'\)/);
    expect(service).toMatch(/WHERE shift_id = \$\{shiftId\}[\s\S]*response_status IN \('pending', 'accepted'\)/);
  });

  it("lets only the assigned worker respond and rejects duplicates", () => {
    const service = read("src/modules/assignments/assignments.service.ts");
    expect(service).toMatch(/w\.user_id = \$\{userId\}/);
    expect(service).toMatch(/FOR UPDATE OF a/);
    expect(service).toMatch(/response_status !== "pending"/);
    expect(service).toMatch(/AssignmentAlreadyRespondedError/);
  });

  it("blocks check-in until the assignment is accepted", () => {
    const verification = read("src/modules/verification/verification.service.ts");
    expect(verification).toMatch(/response_status !== "accepted"/);
    expect(verification).toMatch(/AssignmentNotAcceptedError/);
  });

  it("keeps rejected assignments out of coverage, Family, and messaging", () => {
    const scheduling = read("src/modules/scheduling/scheduling.service.ts");
    const messaging = read("src/modules/messaging/messaging.service.ts");
    expect(scheduling).toMatch(/a\.response_status IN \('pending', 'accepted'\)/);
    expect(scheduling).toMatch(/a\.response_status = 'accepted'/);
    expect(messaging).toMatch(/a\.response_status = 'accepted'/);
  });

  it("notifies the caregiver and organization managers", () => {
    const service = read("src/modules/assignments/assignments.service.ts");
    const managerNotifications = read("migrations/043_assignment_manager_notifications.sql");
    const notifications = read("src/modules/notifications/notifications.service.ts");
    expect(service).toMatch(/SHIFT_ASSIGNMENT_PENDING/);
    expect(service).toMatch(/SHIFT_ASSIGNMENT_ACCEPTED/);
    expect(service).toMatch(/SHIFT_ASSIGNMENT_REJECTED/);
    expect(service).toMatch(/app_notify_assignment_managers/);
    expect(managerNotifications).toMatch(/SECURITY DEFINER SET search_path = public/);
    expect(managerNotifications).toMatch(/a\.response_status = v_expected_response/);
    expect(managerNotifications).toMatch(/w\.user_id = v_actor_user_id/);
    expect(managerNotifications).toMatch(/r\.code IN \('ORGANIZATION_ADMIN', 'SUPERVISOR'\)/);
    expect(managerNotifications).toMatch(/REVOKE ALL ON FUNCTION app_notify_assignment_managers\(uuid, text\) FROM PUBLIC/);
    expect(managerNotifications).toMatch(/GRANT EXECUTE ON FUNCTION app_notify_assignment_managers\(uuid, text\) TO app_runtime/);
    expect(managerNotifications).toMatch(/NOT EXISTS[\s\S]*existing\.related_entity_id = p_assignment_id/);
    expect(notifications).toMatch(/Nuevo turno pendiente de respuesta/);
  });

  it("does not roll back a caregiver response when manager notification fails", () => {
    const service = read("src/modules/assignments/assignments.service.ts");
    const transactionEnd = service.indexOf("return { assignment: updated.rows[0]");
    const notificationCall = service.indexOf("await notifyManagersOfAssignmentResponse(");

    expect(transactionEnd).toBeGreaterThan(-1);
    expect(notificationCall).toBeGreaterThan(transactionEnd);
    expect(service).toMatch(/Assignment response saved but manager notification failed/);
  });
});
