import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const service = read("src/modules/assignments/assignments.service.ts");
const ci = read(".github/workflows/etnara-ci.yml");
const start = service.indexOf("async function syncAssignedWorkerConversationAccess");
const sync = service.slice(start, service.indexOf("async function notifyManagersOfAssignmentResponse"));

describe("assignment acceptance messaging sync", () => {
  it("resolves the thread through the existing SECURITY DEFINER helper", () => {
    expect(sync).toContain("app_find_family_thread_id(${organizationId}, ${recipientId}::uuid)");
    expect(sync).not.toMatch(/FROM message_threads mt/);
  });

  it("never sends an untyped parameter that PostgreSQL cannot resolve", () => {
    expect(sync).not.toMatch(/\$\{roomId\} IS NOT NULL/);
    expect(sync).toContain("room_id = ${roomId}::uuid");
  });

  it("adds only the accepting worker, still under the participants write policy", () => {
    expect(sync).toContain("INSERT INTO message_thread_participants");
    expect(sync).toContain("${workerUserId}, true");
    expect(sync).toContain("withTenantContext({ userId, organizationId }");
    const code = sync.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/SECURITY DEFINER|SET ROLE|set_config\('role'|BYPASSRLS/i);
  });

  it("runs the PostgreSQL verification in CI", () => {
    expect(ci).toContain("scripts/verifyAssignmentMessagingSync.ts");
  });
});
