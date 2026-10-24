import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/112_caregiver_cross_agency_acceptance.sql", "utf8");
const service = readFileSync("src/modules/assignments/assignments.service.ts", "utf8");
const routes = readFileSync("src/modules/assignments/assignments.routes.ts", "utf8");

describe("Layer 1 · a caregiver cannot accept overlapping shifts across agencies", () => {
  it("the helper speaks only about the caller and only yes/no", () => {
    expect(migration).toMatch(/app_my_confirmed_commitment_overlaps\(\s*p_starts timestamptz, p_ends timestamptz, p_except_shift uuid\s*\) RETURNS boolean/);
    expect(migration).toMatch(/w\.user_id = NULLIF\(current_setting\('app\.current_user_id', true\), ''\)::uuid/);
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.app_my_confirmed_commitment_overlaps\(timestamptz, timestamptz, uuid\) FROM PUBLIC;/);
  });

  it("counts only confirmed commitments: accepted, not cancelled; approved visits without a shift", () => {
    expect(migration).toMatch(/WHERE a\.response_status = 'accepted'\s+AND s\.status <> 'cancelled'/);
    expect(migration).toMatch(/ap\.status = 'APPROVED'\s+AND o\.status = 'FILLED'\s+AND o\.shift_id IS NULL/);
    expect(migration).not.toMatch(/'pending'/);
  });

  it("accepting takes a per-person lock, then checks; rejecting never does", () => {
    expect(service).toMatch(/if \(input\.decision === "accepted"\) \{[\s\S]*?await lockPersonSchedule\(trx, assignment\.worker_id\);[\s\S]*?app_my_confirmed_commitment_overlaps/);
    expect(service).toMatch(/"person-schedule:" \+ workerId/);
    expect(routes).toMatch(/res\.status\(409\)\.json\(\{ error: "MY_SCHEDULE_CONFLICT" \}\)/);
  });
});
