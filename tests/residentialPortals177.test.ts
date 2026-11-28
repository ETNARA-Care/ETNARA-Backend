import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reportRange, REPORT_MAX_DAYS } from "../src/modules/residential/reportRange.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const m177 = read("migrations/177_residential_portals.sql");
const rb177 = read("ops/177_residential_portals.rollback.sql");
const ops = read("src/modules/operations/operations.service.ts");
const timeline = read("src/modules/familyTimeline/familyTimeline.service.ts");
const scheduling = read("src/modules/scheduling/scheduling.service.ts");
const central = read("src/modules/platformOrganizations/platformOrganizations.service.ts");

describe("177: migración", () => {
  it("no modifica shifts ni enciende interruptores ni toca organizaciones (solo añade políticas restrictivas)", () => {
    expect(m177).not.toMatch(/ALTER TABLE\s+(public\.)?shifts\b|UPDATE\s+(public\.)?shifts\b|DELETE FROM\s+(public\.)?shifts\b/i);
    expect(m177).not.toMatch(/INSERT INTO\s+(public\.)?organization_features|UPDATE\s+(public\.)?organization_features|UPDATE\s+(public\.)?organizations\b/i);
    expect(m177).not.toMatch(/CREATE TABLE/i);
  });
  it("la conversación familiar de un hogar es solo con la administración: la ventana del personal es falsa en hogares", () => {
    expect(m177).toMatch(/AND NOT public\.app_org_is_residential\(p_organization_id\)/);
    expect(m177).not.toMatch(/OR public\.app_residential_user_has_recipient_now/);
  });
  it("las restricciones de la familia son RESTRICTIVE, solo para app_runtime y solo para el usuario solo-familia de un hogar", () => {
    const tables = ["credentials", "shifts", "assignments", "workers", "organization_worker_memberships", "worker_unavailability_periods",
      "establishment_worker_assignments", "establishment_settings", "establishment_technical_rooms"];
    for (const t of tables) expect(m177).toMatch(new RegExp(`CREATE POLICY residential_family_deny ON ${t} AS RESTRICTIVE FOR ALL TO app_runtime USING \\(NOT public\\.app_residential_family_only\\(\\)\\);`));
    expect(m177).toMatch(/CREATE POLICY residential_family_own_user ON users AS RESTRICTIVE FOR ALL TO app_runtime/);
    expect(m177).toMatch(/AND public\.app_org_is_residential\(ctx\.o\)/);
    expect(m177).toMatch(/r\.code <> 'FAMILY'/);
    expect(m177).toMatch(/owm\.status = 'active'/);
  });
  it("Central recibe solo un número, solo para ETNARA central y solo de hogares", () => {
    expect(m177).toMatch(/CASE WHEN public\.app_is_superadmin\(\) AND public\.app_org_is_residential\(p_organization_id\)/);
    expect(m177).toMatch(/count\(DISTINCT cr\.id\)::int/);
  });
  it("la reversión restaura la 176 y quita todo lo nuevo", () => {
    expect(rb177).toMatch(/OR public\.app_residential_user_has_recipient_now/);
    for (const x of ["app_platform_residential_active_residents", "app_family_activity_authors", "app_residential_family_only"]) expect(rb177).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${x}\\(`));
    expect((rb177.match(/DROP POLICY IF EXISTS/g) ?? []).length).toBe(10);
    expect(rb177).toMatch(/DELETE FROM schema_migrations WHERE filename = '177_residential_portals\.sql'/);
  });
});

describe("177: servicios", () => {
  it("centro operacional sin turnos de la habitación técnica; la familia no ve turnos en hogares; autor por función en hogares", () => {
    expect(ops).toMatch(/AND NOT EXISTS \(SELECT 1 FROM establishment_technical_rooms t WHERE t\.room_id = s\.room_id\)/);
    expect(scheduling).toMatch(/if \(residential\.rows\[0\]\?\.r\) return \[\];/);
    expect(timeline).toMatch(/app_family_activity_authors\(\$\{careRecipientId\}::uuid\)/);
  });
  it("Central: alerta al pasar de 10, Hogar Demo fuera de la alerta", () => {
    expect(central).toMatch(/RESIDENTIAL_SUBSCRIPTION_LIMIT=10/);
    expect(central).toMatch(/overLimit:!demo&&active>RESIDENTIAL_SUBSCRIPTION_LIMIT/);
  });
});

describe("177: rango del informe", () => {
  it("de 1 a 31 días locales; fechas imposibles, invertidas o mal formadas se rechazan", () => {
    expect(REPORT_MAX_DAYS).toBe(31);
    expect(reportRange("2026-11-01", "2026-11-01").days).toBe(1);
    expect(reportRange("2026-11-01", "2026-12-01").days).toBe(31);
    expect(() => reportRange("2026-11-01", "2026-12-02")).toThrow(/RESIDENTIAL_REPORT_RANGE_INVALID/);
    expect(() => reportRange("2026-11-02", "2026-11-01")).toThrow(/RESIDENTIAL_REPORT_RANGE_INVALID/);
    expect(() => reportRange("2026-02-30", "2026-03-01")).toThrow(/INVALID_INPUT/);
    expect(() => reportRange("2026-11-1", "2026-11-02")).toThrow(/INVALID_INPUT/);
    expect(() => reportRange(undefined, "2026-11-02")).toThrow(/INVALID_INPUT/);
  });
});
