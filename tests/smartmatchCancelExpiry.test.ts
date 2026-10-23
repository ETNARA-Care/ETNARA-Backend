import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const m109 = read("migrations/109_smartmatch_cancel_published_and_expiry.sql").replace(/--[^\n]*/g, "");

describe("SmartMatch cancel PUBLISHED + expiry (migration 109)", () => {
  it("closes pending applications as CLOSED (no decider), never REJECTED", () => {
    expect(m109).toContain("CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CLOSED'))");
    expect(m109).toMatch(/status IN \('PENDING', 'WITHDRAWN', 'CLOSED'\) AND decided_by_user_id IS NULL/);
    expect(m109).toMatch(/SET status = 'CLOSED',[\s\S]*?WHERE opportunity_id = NEW\.id AND organization_id = NEW\.organization_id AND status = 'PENDING'/);
  });
  it("locks the opportunity FOR UPDATE before closing (serializes with the FK KEY SHARE of a submission)", () => {
    expect(m109).toMatch(/PERFORM 1 FROM public\.smartmatch_opportunities WHERE id = NEW\.id FOR UPDATE;\s+UPDATE public\.smartmatch_applications/);
  });
  it("requires a reason to cancel PUBLISHED, one notice per applicant, append-only history", () => {
    expect(m109).toMatch(/IF OLD\.status IN \('PUBLISHED', 'FILLED'\) AND NEW\.status = 'CANCELLED' THEN\s+IF NEW\.cancellation_reason IS NULL/);
    expect(m109).toContain("'SMARTMATCH_APPLICATION_OPPORTUNITY_CANCELLED'");
    expect(m109).toContain("'SMARTMATCH_APPLICATION_OPPORTUNITY_EXPIRED'");
    expect(m109).toMatch(/ON CONFLICT \(user_id, notification_type, related_entity_id\)\s+WHERE related_entity_type = 'smartmatch_application'\s+DO NOTHING/);
    expect(m109).toContain("trg_smartmatch_opportunity_events_immutable");
  });
  it("expiry job: background only, skips locked rows, only PUBLISHED", () => {
    expect(m109).toMatch(/app_smartmatch_expire_opportunities[\s\S]*?PERFORM public\.app_assert_background_job\(\);[\s\S]*?WHERE o\.status = 'PUBLISHED'[\s\S]*?FOR UPDATE SKIP LOCKED/);
    expect(read("src/modules/verification/verification.arrival.ts")).toContain("await expireSmartMatchOpportunities();");
  });
});
