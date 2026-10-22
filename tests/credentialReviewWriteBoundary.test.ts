import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read=(p:string)=>readFileSync(new URL(`../${p}`,import.meta.url),"utf8");

describe("organization credential review write boundary",()=>{
  it("keeps direct review decisions manager-only at RLS",()=>{
    const migration=read("migrations/082_credential_review_write_boundary.sql");
    expect(migration).toContain("organization_credential_reviews_manager_insert");
    expect(migration).toContain("organization_credential_reviews_manager_update");
    expect(migration).toContain("organization_credential_reviews_manager_delete");
    expect(migration).toMatch(/FOR UPDATE[\s\S]*app_is_org_manager\(\)/);
    expect(migration).toMatch(/reviewed_by_user_id = NULLIF\(current_setting\('app.current_user_id'/);
  });

  it("allows caregiver replacement to reset only its own credential through a narrow helper",()=>{
    const migration=read("migrations/082_credential_review_write_boundary.sql");
    expect(migration).toContain("app_reset_credential_review_pending");
    expect(migration).toContain("w.user_id = v_current_user_id");
    expect(migration).toContain("owm.organization_id = v_organization_id");
    expect(migration).toContain("owm.status = 'active'");
    expect(migration).toMatch(/SET review_status = 'pending',[\s\S]*notes = NULL,[\s\S]*reviewed_at = NULL/);
    expect(migration).toContain("SECURITY DEFINER SET search_path = public");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app_reset_credential_review_pending(uuid) FROM PUBLIC");
  });

  it("does not let platform authority directly write tenant review decisions",()=>{
    const migration=read("migrations/082_credential_review_write_boundary.sql");
    const writeSection=migration.slice(migration.indexOf("organization_credential_reviews_manager_insert"));
    expect(writeSection).not.toMatch(/FOR (INSERT|UPDATE|DELETE)[\s\S]{0,500}app_is_superadmin\(\)/);
  });
});
