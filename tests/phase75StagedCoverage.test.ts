import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Phase 7.5 staged coverage escalation", () => {
  it("queues ranked candidates and activates one auditable wave at a time", () => {
    const migration = read("migrations/054_staged_coverage_escalation.sql");
    expect(migration).toContain("response_status = 'queued'");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("wave_number");
    expect(migration).toContain("response_due_at");
    expect(migration).toContain("response_status <> 'queued'");
  });

  it("stops escalation on interest and keeps final assignment human", () => {
    const migration = read("migrations/054_staged_coverage_escalation.sql");
    const service = read("src/modules/coverageOffers/coverageOffers.service.ts");
    expect(migration).toContain("response_status = 'interested'");
    expect(service).toContain("app_progress_coverage_campaign_after_response");
    expect(service).not.toContain("INSERT INTO assignments");
    expect(migration).not.toContain("INSERT INTO assignments");
  });

  it("withdraws active and queued offers when the shift closes", () => {
    const assignments = read("src/modules/assignments/assignments.service.ts");
    const scheduling = read("src/modules/scheduling/scheduling.service.ts");
    expect(assignments).toContain("response_status IN ('pending', 'queued')");
    expect(scheduling).toContain("status = 'cancelled', next_wave_at = NULL");
    expect(scheduling).toContain("response_status IN ('pending', 'queued')");
  });

  it("runs due progression through a bounded idempotent worker", () => {
    const migration = read("migrations/054_staged_coverage_escalation.sql");
    const worker = read("src/modules/coverageOffers/coverageEscalation.worker.ts");
    expect(migration).toContain("app_advance_due_coverage_campaigns");
    expect(worker).toContain("setInterval");
    expect(worker).toContain("timer.unref()");
    expect(worker).not.toContain("console.error(error)");
  });

  it("keeps queued offers hidden from caregivers until activation", () => {
    const service = read("src/modules/coverageOffers/coverageOffers.service.ts");
    expect(service).toContain("offer.response_status IN ('pending', 'interested', 'declined')");
    expect(service).toContain("offer.response_due_at > now()");
  });
});
