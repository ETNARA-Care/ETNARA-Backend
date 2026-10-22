import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read=(p:string)=>readFileSync(new URL(`../${p}`,import.meta.url),"utf8");

describe("export/report security guardrails",()=>{
  it("documents mandatory tenant and platform boundaries",()=>{
    const policy=read("docs/security/EXPORT_REPORTING_STANDARD.md");
    expect(policy).toContain("Tenant context is required");
    expect(policy).toContain("No Platform bulk access to tenant private data");
    expect(policy).toContain("No raw storage keys or signed URLs in bulk exports");
    expect(policy).toContain("Platform denial for private tenant data");
  });

  it("fails unreviewed export/report surfaces by default",()=>{
    const guard=read("scripts/verifyExportReportSecurity.ts");
    expect(guard).toContain("EXPORT_REPORT_SECURITY_GUARD_FAILED");
    expect(guard).toContain("withTenantContext");
    expect(guard).toContain("withPlatformContext");
    expect(guard).toContain("ALLOWED_PLATFORM_EXPORT_FILES");
  });

  it("runs the guard in CI",()=>{
    const workflow=read(".github/workflows/etnara-ci.yml");
    expect(workflow).toContain("Export/report security guard");
    expect(workflow).toContain("npx tsx scripts/verifyExportReportSecurity.ts");
  });
});
