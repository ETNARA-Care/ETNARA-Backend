import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../migrations/075_active_visit_recipient_access.sql", import.meta.url));
const source = readFileSync(path, "utf8");

describe("worker recipient access across visit lifecycle", () => {
  it("preserves access past scheduled end only for an accepted active visit", () => {
    expect(source).toContain("s.scheduled_end > now()");
    expect(source).toContain("a.response_status = 'accepted'");
    expect(source).toContain("s.status = 'in_progress'");
    expect(source).toContain("check_in.event_type = 'check_in'");
    expect(source).toContain("check_out.event_type = 'check_out'");
    expect(source).toContain("check_out.occurred_at > check_in.occurred_at");
  });

  it("still requires live tenant membership, assignment, and recipient linkage", () => {
    expect(source).toContain("owm.status = 'active'");
    expect(source).toContain("a.response_status IN ('pending', 'accepted')");
    expect(source).toContain("s.organization_id = a.organization_id");
    expect(source).toContain("a.care_recipient_id = p_care_recipient_id");
    expect(source).toContain("s.care_recipient_id = p_care_recipient_id");
    expect(source).toContain("s.room_id = app_recipient_room_id(p_care_recipient_id)");
  });
});
