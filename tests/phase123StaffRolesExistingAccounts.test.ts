import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const team = readFileSync("src/modules/team/team.service.ts", "utf8");
const teamRoutes = readFileSync("src/modules/team/team.routes.ts", "utf8");
const platform = readFileSync("src/modules/platformOrganizations/platformOrganizations.service.ts", "utf8");
const platformRoutes = readFileSync("src/modules/platformOrganizations/platformOrganizations.routes.ts", "utf8");
const ci = readFileSync(".github/workflows/etnara-ci.yml", "utf8");

describe("Phase 12.3 · staff roles and existing accounts", () => {
  it("only administrators change staff roles, with self and last-admin guards", () => {
    const fn = team.slice(team.indexOf("export async function setStaffRole"));
    expect(fn).toMatch(/await assertOrgAdmin\(trx\);/);
    expect(fn).toMatch(/pg_advisory_xact_lock/);
    expect(fn).toMatch(/CANNOT_REMOVE_OWN_ADMIN/);
    expect(fn).toMatch(/LAST_ADMIN/);
    expect(fn).toMatch(/NO_ACCOUNT_YET/);
    expect(team).toMatch(/role: staffRoleSchema,\s+enabled: z\.boolean\(\),\s+\}\)\.strict\(\)/);
    expect(teamRoutes).toMatch(/"\/organizations\/:organizationId\/team\/roles"/);
  });

  it("an existing account accepts only after signing in, as the invited person", () => {
    expect(platformRoutes).toMatch(/router\.post\("\/platform\/admin-invitations\/accept",requireAuth/);
    expect(platform).toMatch(/app_activate_organization_admin_invitation\(\$\{hashToken\(rawToken\)\},NULL,\$\{userId\}::uuid\)/);
  });

  it("runs the HTTP verification in CI", () => {
    expect(ci).toMatch(/scripts\/verifyStaffRolesAndExistingAccounts\.ts/);
  });
});
