import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("Family access regression contracts", () => {
  it("returns only reviewed observations from the curated endpoint and RLS", () => {
    const service = read("src/modules/observations/observations.service.ts");
    const migration = read("migrations/038_cross_portal_family_read_access.sql");
    expect(service).toMatch(/FROM observations[\s\S]*AND status = 'reviewed'/);
    expect(migration).toMatch(/CREATE POLICY observations_family_read[\s\S]*AND status = 'reviewed'/);
  });

  it.each([
    "src/modules/observations/observations.service.ts",
    "src/modules/incidents/incidents.service.ts",
    "src/modules/scheduling/scheduling.service.ts",
  ])("requires an active FAMILY membership in %s", (path) => {
    const service = read(path);
    expect(service).toMatch(/om\.status = 'active' AND r\.code = 'FAMILY'/);
  });

  it("rechecks live recipient authorization for messaging", () => {
    const migration = read("migrations/038_cross_portal_family_read_access.sql");
    expect(migration).toMatch(/CREATE POLICY message_threads_read[\s\S]*app_user_authorized_for_recipient/);
    expect(migration).toMatch(/CREATE POLICY message_threads_create[\s\S]*app_user_authorized_for_recipient/);
    expect(migration).toMatch(/CREATE POLICY message_thread_participants_write[\s\S]*app_user_authorized_for_recipient/);
  });

  it("adds newly assigned workers to existing recipient conversations", () => {
    const assignments = read("src/modules/assignments/assignments.service.ts");
    const backfill = read("migrations/041_assignment_message_participants.sql");
    expect(assignments).toMatch(/INSERT INTO message_thread_participants[\s\S]*ON CONFLICT \(message_thread_id, user_id\) DO NOTHING/);
    expect(backfill).toMatch(/JOIN assignments a[\s\S]*JOIN workers w[\s\S]*ON CONFLICT \(message_thread_id, user_id\) DO NOTHING/);
  });
});
