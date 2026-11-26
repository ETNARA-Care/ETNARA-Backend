import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const m180 = read("migrations/180_family_rls_scope.sql");
const rb180 = read("ops/180_family_rls_scope.rollback.sql");
const FNS = ["app_family_only_member", "app_family_has_recipient", "app_family_recipient_shift", "app_family_visible_membership", "app_family_visible_worker"];

describe("180: alcance de la familia en la RLS", () => {
  it("solo añade funciones y políticas: sin tablas, sin datos, sin tocar la estructura de shifts ni interruptores", () => {
    expect(m180).not.toMatch(/CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE\s+\w|DELETE FROM/i);
    expect(m180).not.toMatch(/organization_features/);
  });
  it("todas las políticas son RESTRICTIVE, solo para app_runtime y se desactivan para quien no es solo familia", () => {
    const policies = [...m180.matchAll(/CREATE POLICY (\w+) ON (\w+) AS (\w+) FOR ALL TO (\w+)\s+USING \((NOT public\.app_family_only_member\(\))/g)];
    expect(policies.length).toBe(8);
    for (const p of policies) { expect(p[3]).toBe("RESTRICTIVE"); expect(p[4]).toBe("app_runtime"); }
    for (const t of ["users", "shifts", "assignments", "organization_worker_memberships", "workers", "credentials", "worker_unavailability_periods", "establishment_worker_assignments"])
      expect(m180).toMatch(new RegExp(`CREATE POLICY \\w+ ON ${t} AS RESTRICTIVE`));
  });
  it("solo familia = rol FAMILY sin ningún otro rol ni membresía de empleado activa; nunca ETNARA central", () => {
    expect(m180).toMatch(/r\.code = 'FAMILY'/);
    expect(m180).toMatch(/r\.code <> 'FAMILY'/);
    expect(m180).toMatch(/owm\.status = 'active'/);
    expect(m180).toMatch(/NOT public\.app_is_superadmin\(\)/);
  });
  it("las funciones son SECURITY DEFINER con search_path fijo, devuelven boolean, sin ejecución para PUBLIC", () => {
    for (const f of FNS) {
      expect(m180).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${f}\\([^)]*\\)\\s+RETURNS boolean\\s+LANGUAGE sql\\s+STABLE\\s+SECURITY DEFINER\\s+SET search_path = pg_catalog, public`));
      expect(m180).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\(`));
    }
  });
  it("independiente de 171–177: nombres de política propios y sin referencias a tablas de hogares", () => {
    expect(m180).not.toMatch(/residential_family_|establishment_technical_rooms|shift_resident_assignments|attendance_|schedule_week/);
  });
  it("la reversión quita todo lo nuevo", () => {
    expect((rb180.match(/DROP POLICY IF EXISTS/g) ?? []).length).toBe(8);
    for (const f of FNS) expect(rb180).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${f}\\(`));
    expect(rb180).toMatch(/DELETE FROM schema_migrations WHERE filename = '180_family_rls_scope\.sql'/);
  });
});
