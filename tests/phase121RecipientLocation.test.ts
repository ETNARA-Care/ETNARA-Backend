import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/082_care_recipient_locations.sql", "utf8")
  .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
const service = readFileSync("src/modules/careRecipients/careRecipients.service.ts", "utf8");
const routes = readFileSync("src/modules/careRecipients/careRecipients.routes.ts", "utf8");
const phi = readFileSync("scripts/verifyPlatformPhiBoundary.ts", "utf8");
const ci = readFileSync(".github/workflows/etnara-ci.yml", "utf8");

describe("Phase 12.1 · care recipient address", () => {
  it("keeps the address in its own RLS-protected table", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS care_recipient_locations/);
    expect(migration).toMatch(/ALTER TABLE care_recipient_locations ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/\(latitude IS NULL\) = \(longitude IS NULL\)/);
  });

  it("lets managers and assigned workers read, and no one else", () => {
    const read = migration.match(/CREATE POLICY care_recipient_locations_read[\s\S]*?;/)?.[0] ?? "";
    expect(read).toMatch(/FOR SELECT/);
    expect(read).toMatch(/app_is_org_manager\(\) OR app_worker_has_recipient_assignment\(care_recipient_id\)/);
    expect(read).not.toMatch(/family/i);
    expect(migration).not.toMatch(/app_family|family_relationships/);
  });

  it("only managers write, nobody deletes, platform admins are denied", () => {
    for (const name of ["manager_insert", "manager_update"]) {
      const policy = migration.match(new RegExp(`CREATE POLICY care_recipient_locations_${name}[\\s\\S]*?;`))?.[0] ?? "";
      expect(policy).toMatch(/app_is_org_manager\(\)/);
    }
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE ON care_recipient_locations TO app_runtime;/);
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*care_recipient_locations/);
    expect(migration).toMatch(/CREATE POLICY platform_phi_deny ON care_recipient_locations\s+AS RESTRICTIVE FOR ALL TO app_runtime/);
    expect(phi).toMatch(/"care_recipient_locations"/);
  });

  it("binds the location to the recipient's organization", () => {
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
    expect(migration).toMatch(/CARE_RECIPIENT_LOCATION_ORG_MISMATCH/);
  });

  it("exposes GET and PUT with strict validation and a 403 for non-managers", () => {
    expect(routes).toMatch(/router\.get\(\s*"\/organizations\/:organizationId\/care-recipients\/:recipientId\/location"/);
    expect(routes).toMatch(/router\.put\(\s*"\/organizations\/:organizationId\/care-recipients\/:recipientId\/location"/);
    expect(routes).toMatch(/LOCATION_WRITE_FORBIDDEN/);
    expect(service).toMatch(/upsertLocationSchema = z[\s\S]*?\.strict\(\)/);
  });

  it("runs the HTTP + RLS verification in CI", () => {
    expect(ci).toMatch(/scripts\/verifyRecipientLocationAccess\.ts/);
  });
});
