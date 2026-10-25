import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const O = "11111111-2222-4333-8444-555555555555";

describe("ETNARA Facturación F2.1 — premium switch, permissions and security (123)", () => {
  const m123 = read("migrations/123_billing_foundation.sql");
  const code = m123.replace(/--.*$/gm, "");
  const rollback = read("ops/123_billing_foundation.rollback.sql");
  const service = read("src/modules/billing/billing.service.ts");
  const routes = read("src/modules/billing/billing.routes.ts");
  const platform = read("src/modules/platformOrganizations/platformOrganizationFeatures.ts");

  it("is additive: only the two feature CHECK lists change, no row of another module is touched", () => {
    expect(code).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
    expect(code).not.toMatch(/\b(shifts|timesheets|finance_rates|finance_services|billing_clients)\b/);
    expect(code).not.toMatch(/INSERT INTO organization_features/); // off for every agency: no row is created
    expect(code).not.toMatch(/GRANT[^;]*DELETE/);
    expect(code).toContain("'SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION'");
  });

  it("FACTURACION requires FINANZAS in the database and billing needs both switches", () => {
    expect(m123).toContain("FEATURE_REQUIRES_FINANZAS");
    expect(m123).toMatch(/CREATE TRIGGER organization_features_billing_dependency/);
    expect(m123).toMatch(/app_org_feature_enabled\(p_organization_id, 'FINANZAS'\)[\s\S]*app_org_feature_enabled\(p_organization_id, 'FACTURACION'\)/);
  });

  it("permissions are append-only, admin-only, five capabilities, and the last manager is protected under a lock", () => {
    expect(m123).toContain("CHECK (capability IN ('view', 'draft', 'issue', 'void', 'manage'))");
    expect(m123).toContain("BILLING_PERMISSION_NO_DELETE");
    expect(m123).toContain("BILLING_PERMISSION_ADMIN_ONLY");
    expect(m123).toContain("LAST_PERMISSION_MANAGER");
    expect(m123).toMatch(/pg_advisory_xact_lock\(hashtextextended\(concat_ws\('\|', 'billing-manage'/);
    expect(m123).toContain("GRANT UPDATE (revoked_at, revoked_by_user_id, revoke_reason) ON billing_permissions TO app_runtime");
    expect(m123).toMatch(/CREATE POLICY platform_finance_deny ON billing_permissions AS RESTRICTIVE/);
  });

  it("the API revocation waits for the same lock before checking the actor and never reports a revocation that did not happen", () => {
    const revoke = service.slice(service.indexOf("export async function revokePermission"));
    expect(revoke.indexOf("pg_advisory_xact_lock")).toBeLessThan(revoke.indexOf("requireCapability"));
    expect(revoke).toContain('if (!after) throw new BillingError("BILLING_FORBIDDEN", 403)');
  });

  it("ETNARA central only sees administrators (no money) and only designates a manager with a reason", () => {
    const fn = m123.slice(m123.indexOf("FUNCTION public.app_platform_billing_admins"), m123.indexOf("FUNCTION public.app_platform_designate_billing_manager"));
    expect(fn).not.toMatch(/cents|amount|rate|invoice/i);
    expect(m123).toMatch(/app_platform_designate_billing_manager[\s\S]*REASON_REQUIRED/);
    expect(platform).toMatch(/FEATURE_CODES = \[[^\]]*"FACTURACION"[^\]]*\]/);
    expect(platform).toContain("/platform/organizations/:organizationId/billing-manager");
  });

  it("the gate keeps reads available in read-only mode and blocks writes when FACTURACION is off", () => {
    expect(gatedFeatureFor(`/organizations/${O}/billing/access`)).toEqual({ organizationId: O, feature: "FACTURACION", readOnlyPass: true });
    expect(gatedFeatureFor(`/organizations/${O}/billing/permissions`, "POST")).toEqual({ organizationId: O, feature: "FACTURACION" });
    expect(gatedFeatureFor(`/organizations/${O}/finance/services`, "GET")).toEqual({ organizationId: O, feature: "FINANZAS" });
    expect(gatedFeatureFor(`/organizations/${O}/billingx`)).toBeNull();
    expect(read("src/middleware/featureWriteLimit.ts")).toMatch(/billing/);
  });

  it("routes require authentication and every write needs a reason", () => {
    expect(routes.match(/requireAuth/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(service).toMatch(/grantSchema = z\.object\([\s\S]*reason/);
    expect(service).toMatch(/revokeSchema = z\.object\([\s\S]*reason/);
  });

  it("the rollback refuses to run when there is FACTURACION history or any permission", () => {
    expect(rollback).toContain("rollback aborted, nothing changed");
    expect(rollback).toMatch(/EXISTS \(SELECT 1 FROM billing_permissions\)/);
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE filename = '123_billing_foundation.sql'");
  });
});
