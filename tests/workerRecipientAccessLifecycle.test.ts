import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../migrations/070_revoke_stale_recipient_access.sql", import.meta.url));
const source = readFileSync(path, "utf8");

describe("worker recipient access lifecycle", () => {
  it("requires an active assignment and operational shift", () => {
    expect(source).toContain("a.response_status IN ('pending', 'accepted')");
    expect(source).toContain("s.status IN ('unassigned', 'confirmed', 'in_progress')");
    expect(source).toContain("s.scheduled_end > now()");
    expect(source).toContain("owm.status = 'active'");
  });

  it("preserves direct and residential linkage inside the tenant", () => {
    expect(source).toContain("a.care_recipient_id = p_care_recipient_id");
    expect(source).toContain("s.care_recipient_id = p_care_recipient_id");
    expect(source).toContain("s.room_id = app_recipient_room_id(p_care_recipient_id)");
    expect(source).toContain("s.organization_id = a.organization_id");
  });
});
