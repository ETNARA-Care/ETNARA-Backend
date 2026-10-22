import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/085_org_admin_authority.sql", "utf8")
  .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
const team = readFileSync("src/modules/team/team.service.ts", "utf8");
const routes = readFileSync("src/modules/team/team.routes.ts", "utf8");
const timesheets = readFileSync("src/modules/timesheets/timesheets.service.ts", "utf8");
const payPeriods = readFileSync("src/modules/timesheets/payPeriods.service.ts", "utf8");
const payPeriodRoutes = readFileSync("src/modules/timesheets/payPeriods.routes.ts", "utf8");
const ci = readFileSync(".github/workflows/etnara-ci.yml", "utf8");

describe("Phase 12.2 · team invitations and administrator authority", () => {
  it("authority helpers are SECURITY DEFINER with a fixed search_path", () => {
    for (const fn of ["app_is_org_admin()", "app_is_org_manager_definer()", "app_role_code(p_role_id uuid)"]) {
      const body = migration.slice(migration.indexOf(`FUNCTION public.${fn}`));
      expect(body.slice(0, 200)).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
    }
  });

  it("closes direct writes to roles and memberships by non-administrators", () => {
    expect(migration).toMatch(/CREATE POLICY user_roles_insert_authority ON user_roles\s+AS RESTRICTIVE FOR INSERT TO app_runtime/);
    expect(migration).toMatch(/app_is_org_manager_definer\(\) AND app_role_code\(role_id\) IN \('WORKER', 'FAMILY'\)/);
    expect(migration).toMatch(/CREATE POLICY user_roles_delete_authority ON user_roles\s+AS RESTRICTIVE FOR DELETE/);
    for (const op of ["insert", "update", "delete"]) {
      expect(migration).toMatch(new RegExp(`CREATE POLICY organization_memberships_${op}_authority ON organization_memberships\\s+AS RESTRICTIVE`));
    }
  });

  it("only administrators (or the platform) handle staff invitations", () => {
    expect(migration).toMatch(/staff_role IN \('ORGANIZATION_ADMIN', 'SUPERVISOR'\)/);
    for (const op of ["read", "insert", "update"]) {
      expect(migration).toMatch(new RegExp(`CREATE POLICY access_invitations_staff_${op}_authority ON access_invitations\\s+AS RESTRICTIVE`));
    }
    expect(migration).toMatch(/WHERE role_record\.code = v_inv\.staff_role/);
    expect(team).toMatch(/SELECT app_is_org_admin\(\) AS ok/);
    expect(team).toMatch(/role: staffRoleSchema/);
    expect(team).toMatch(/\.strict\(\)/);
    expect(routes).toMatch(/TEAM_FORBIDDEN/);
  });

  it("money is for administrators only", () => {
    for (const table of ["worker_financial_rates", "timesheets", "pay_periods", "pay_period_timesheets"]) {
      expect(migration).toMatch(new RegExp(`CREATE POLICY ${table}_admin_only ON ${table}\\s+AS RESTRICTIVE FOR ALL TO app_runtime`));
    }
    expect(timesheets).toMatch(/SELECT app_is_org_admin\(\) AS is_manager/);
    expect(payPeriods).toMatch(/SELECT app_is_org_admin\(\) ok/);
    expect(payPeriodRoutes).toMatch(/e instanceof TimesheetForbiddenError\|\|e instanceof MembershipNotActiveError\)return void res\.status\(403\)/);
  });

  it("runs the HTTP + RLS verification in CI", () => {
    expect(ci).toMatch(/scripts\/verifyTeamAndAdminAuthority\.ts/);
  });
});
