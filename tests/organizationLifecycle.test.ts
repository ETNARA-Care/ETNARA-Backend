import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const read=(p:string)=>readFileSync(new URL(`../${p}`,import.meta.url),"utf8");
describe("Phase 6.1 organization lifecycle guards",()=>{
 const service=read("src/modules/platformOrganizations/platformOrganizations.service.ts");
 const routes=read("src/modules/platformOrganizations/platformOrganizations.routes.ts");
 const context=read("src/context/tenantContext.ts");
 const migration=read("migrations/077_organization_lifecycle_events.sql");
 it("requires platform authority and a reason for every lifecycle change",()=>{
  expect(service).toContain("withPlatformContext(userId");
  expect(service).toContain('z.enum(["suspend","archive","reactivate"])');
  expect(service).toContain("reason:z.string().trim().min(5)");
  expect(routes).toContain('router.patch("/platform/organizations/:organizationId/lifecycle",requireAuth');
 });
 it("keeps history and records transitions without deleting organizations",()=>{
  expect(service).toContain("INSERT INTO organization_lifecycle_events");
  expect(service).toContain("archived_at=now()");
  expect(service).toContain("archived_at=NULL");
  expect(service).not.toMatch(/DELETE FROM organizations/i);
  expect(migration).toContain("organization_lifecycle_events_platform_only");
  expect(migration).toContain("GRANT SELECT, INSERT ON organization_lifecycle_events TO app_runtime");
 });
 it("blocks suspended tenant requests while preserving trial access",()=>{
  expect(context).toContain("status IN ('active', 'trial')");
  expect(context).toContain("archived_at IS NULL");
  expect(service).toContain("AND status IN ('active','trial') AND archived_at IS NULL");
 });
 it("revokes pending invitations and prevents suspended-tenant activation",()=>{
  expect(service).toContain("UPDATE access_invitations SET status='revoked'");
  expect(migration).toContain("target_org.status IN ('active', 'trial')");
  expect(migration).toContain("target_org.archived_at IS NULL");
  expect(migration).toContain("FOR UPDATE");
 });
});
