import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sqlOnly = (s: string) => s.replace(/--.*$/gm, "");

describe("migración 140: cierre del acceso permanente de Central a documentos institucionales", () => {
  const migration = sqlOnly(read("migrations/140_platform_establishment_document_closure.sql"));
  const rollback = sqlOnly(read("ops/140_platform_establishment_document_closure.rollback.sql"));

  it("usa un número libre: es la única migración 140", () => {
    expect(readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.startsWith("140_"))).toEqual([
      "140_platform_establishment_document_closure.sql",
    ]);
  });

  it("solo retira las políticas de Central y añade la restrictiva; no toca permisos, datos ni políticas de la agencia", () => {
    expect(migration).not.toMatch(/\b(GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|ALTER TABLE|DROP TABLE|DROP TRIGGER|CREATE TRIGGER)\b/i);
    expect(migration).not.toMatch(/establishment_documents_(read|insert|update)\b/);
    expect(migration).not.toContain("resident_documents");
    expect(migration.match(/DROP POLICY IF EXISTS/g)?.length).toBe(3);
    expect(migration.match(/CREATE POLICY/g)?.length).toBe(1);
  });

  it("la reversión restaura exactamente las dos políticas de la 125 y retira la restrictiva", () => {
    const m125 = read("migrations/125_document_access_fix.sql");
    for (const name of ["establishment_documents_platform_review_read", "establishment_documents_platform_review_update"]) {
      const stmt = m125.match(new RegExp(`CREATE POLICY ${name}[\\s\\S]*?\\);`))?.[0];
      expect(stmt).toBeTruthy();
      expect(rollback).toContain(stmt!);
    }
    expect(rollback).toContain("DROP POLICY IF EXISTS platform_phi_deny ON establishment_documents;");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE filename = '140_platform_establishment_document_closure.sql';");
    expect(rollback).not.toContain("resident_documents");
  });
});
