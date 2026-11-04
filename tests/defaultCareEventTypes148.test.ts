import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 148 (validación de agencias fundadoras, 4-nov-2026): garantías que no deben perderse al editar el archivo.
const sql = readFileSync("migrations/148_default_care_event_types.sql", "utf8");
const code = sql.replace(/--.*$/gm, "");
const rollback = readFileSync("ops/148_default_care_event_types.rollback.sql", "utf8").replace(/--.*$/gm, "");
const rollbackFull = readFileSync("ops/148_default_care_event_types.rollback_full.sql", "utf8").replace(/--.*$/gm, "");

describe("148 default care event types", () => {
  it("activa exactamente los 8 tipos de Casa Demo", () => {
    expect(code).toContain("ARRAY['MEAL','HYDRATION','TOILETING','MOBILITY','ACTIVITY','MOOD','NOTE','PHOTO']");
  });

  it("nunca modifica ni borra configuración existente: solo inserta con ON CONFLICT DO NOTHING", () => {
    expect(code).not.toMatch(/UPDATE\s+(public\.)?organization_care_event_types/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+(public\.)?organization_care_event_types/i);
    expect(code).toMatch(/INSERT INTO public\.organization_care_event_types[\s\S]*?ON CONFLICT \(organization_id, care_event_type_id\) DO NOTHING/);
  });

  it("el relleno solo alcanza agencias sin ninguna fila y no archivadas", () => {
    expect(code).toMatch(/archived_at IS NULL/);
    expect(code).toMatch(/NOT EXISTS \(SELECT 1 FROM organization_care_event_types x WHERE x\.organization_id = o\.id\)/);
  });

  it("es reaplicable y no concede nada a app_runtime ni a PUBLIC", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS care_event_type_default_grants/);
    expect(code).toMatch(/DROP TRIGGER IF EXISTS organizations_default_care_event_types/);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.app_provision_default_care_event_types\(uuid, text\) FROM PUBLIC/);
    expect(code).toMatch(/REVOKE ALL ON care_event_type_default_grants FROM app_runtime/);
    for (const fn of code.matchAll(/SECURITY DEFINER\s*\n\s*SET search_path = pg_catalog, public/g)) expect(fn).toBeTruthy();
    expect((code.match(/SECURITY DEFINER/g) ?? []).length).toBe((code.match(/SECURITY DEFINER\s*\n\s*SET search_path = pg_catalog, public/g) ?? []).length);
  });

  it("las reversiones quitan todo lo que crea 148 y la completa solo borra lo registrado y sin cambios", () => {
    for (const r of [rollback, rollbackFull]) {
      for (const obj of ["organizations_default_care_event_types", "app_on_organization_created_care_event_types", "app_provision_default_care_event_types", "app_default_care_event_type_codes", "care_event_type_default_grants", "148_default_care_event_types.sql"]) expect(r).toContain(obj);
    }
    expect(rollback).not.toMatch(/DELETE\s+FROM\s+organization_care_event_types/i);
    expect(rollbackFull).toMatch(/USING care_event_type_default_grants/);
    expect(rollbackFull).toMatch(/is_enabled = true[\s\S]*label_override IS NULL[\s\S]*display_order IS NULL[\s\S]*is_required = false/);
  });
});
