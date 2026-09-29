import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("Assignment response contracts", () => {
  it("keeps staging bootstrap explicit instead of running it from production start", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.start).toBe("tsx src/index.ts");
    expect(packageJson.scripts?.["start:staging"]).toMatch(/^npm run bootstrap:staging && /);
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
});
