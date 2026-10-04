import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../migrations/076_revoke_stale_shift_access.sql", import.meta.url));
const source = readFileSync(path, "utf8");

describe("worker shift access lifecycle", () => {
  it("rejects stale assignment-only access", () => {
    expect(source).toContain("a.response_status IN ('pending', 'accepted')");
    expect(source).toContain("s.status IN ('unassigned', 'confirmed', 'in_progress')");
    expect(source).toContain("s.scheduled_end > now()");
    expect(source).toContain("owm.status = 'active'");
  });

  it("preserves an accepted genuinely active visit past scheduled end", () => {
    expect(source).toContain("a.response_status = 'accepted'");
    expect(source).toContain("s.status = 'in_progress'");
    expect(source).toContain("check_in.event_type = 'check_in'");
    expect(source).toContain("check_out.event_type = 'check_out'");
    expect(source).toContain("check_out.occurred_at > check_in.occurred_at");
  });

  it("binds the shift to the same tenant as the assignment", () => {
    expect(source).toContain("s.organization_id = a.organization_id");
    expect(source).toContain("a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid");
  });
});
