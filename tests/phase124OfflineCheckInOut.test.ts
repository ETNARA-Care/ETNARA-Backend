import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/087_offline_check_in_out.sql", "utf8");
const service = readFileSync("src/modules/verification/verification.service.ts", "utf8");
const routes = readFileSync("src/modules/verification/verification.routes.ts", "utf8");
const auth = readFileSync("src/modules/auth/auth.service.ts", "utf8");
const env = readFileSync("src/config/env.ts", "utf8");
const ci = readFileSync(".github/workflows/etnara-ci.yml", "utf8");

describe("Phase 12.4 · offline check-in/out and caregiver session", () => {
  it("is additive: device id, offline flag and a scoped unique index", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS client_event_id uuid NULL/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS recorded_offline boolean NOT NULL DEFAULT false/);
    expect(migration).toMatch(/ON verification_events \(organization_id, organization_worker_membership_id, client_event_id\)\s+WHERE client_event_id IS NOT NULL/);
    expect(migration).not.toMatch(/DROP POLICY|CREATE POLICY/);
  });

  it("the late-retry lookup is a definer limited to the caller's own record", () => {
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
    expect(migration).toMatch(/w\.user_id = NULLIF\(current_setting\('app\.current_user_id', true\), ''\)::uuid/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.app_find_own_verification_event/);
  });

  it("validates the device time: not in the future, not older than 7 days, after its check-in", () => {
    expect(service).toMatch(/const MAX_OFFLINE_AGE_MS = 7 \* 24 \* 3600 \* 1000;/);
    expect(service).toMatch(/if \(occurred > now \+ MAX_CLOCK_SKEW_MS\) throw new OccurredAtOutOfRangeError\(\);/);
    expect(service).toMatch(/resolveOccurredAt\(input\.occurredAt, active\.occurred_at\)/);
    expect(routes).toMatch(/OCCURRED_AT_OUT_OF_RANGE/);
  });

  it("a retry returns the stored record and never inserts twice", () => {
    expect(service.match(/DO NOTHING/g)?.length).toBeGreaterThanOrEqual(2);
    expect(routes).toMatch(/res\.status\(replayed \? 200 : 201\)/);
  });

  it("only caregiver-only accounts get the long session, capped at 7 days", () => {
    expect(env).toMatch(/WORKER_SESSION_DURATION_HOURS[\s\S]*default\("168"\)[\s\S]*max\(168\)/);
    expect(auth).toMatch(/return codes\.length === 1 && codes\[0\] === "WORKER";/);
  });

  it("runs the HTTP verification in CI", () => {
    expect(ci).toMatch(/scripts\/verifyOfflineCheckInOut\.ts/);
  });
});
