import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { practiceDocumentStatus } from "../src/modules/practice/practiceStatus.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const mig = read("migrations/161_self_declared_documents_provider_reports.sql");
const rollback = read("ops/161_self_declared_documents_provider_reports.rollback.sql");
const fnOf = (src: string, name: string) => { const i = src.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`); return src.slice(i, src.indexOf("$$;", src.indexOf("AS $$", i)) + 3); };

describe("161: documentos autodeclarados, elegibilidad propia e «Informe del proveedor»", () => {
  it("estados solo por lo registrado; nunca verificado ni aprobado", () => {
    const t = "2026-11-24";
    expect(practiceDocumentStatus(null, t)).toBe("MISSING");
    expect(practiceDocumentStatus({ status: "active", expires_at: null }, t)).toBe("REGISTERED");
    expect(practiceDocumentStatus({ status: "active", expires_at: "2027-06-01" }, t)).toBe("REGISTERED");
    expect(practiceDocumentStatus({ status: "active", expires_at: "2026-12-20" }, t)).toBe("EXPIRING_SOON");
    expect(practiceDocumentStatus({ status: "active", expires_at: "2026-11-24" }, t)).toBe("EXPIRING_SOON");
    expect(practiceDocumentStatus({ status: "active", expires_at: "2026-11-23" }, t)).toBe("EXPIRED");
    expect(practiceDocumentStatus({ status: "revoked", expires_at: "2027-01-01" }, t)).toBe("RETIRED");
    const svc = read("src/modules/practice/practiceDocuments.service.ts");
    expect(svc).not.toMatch(/"VERIFIED"|"APPROVED"|"CERTIFIED"/);
  });
  it("las funciones redefinidas son las vigentes más bloques «161», y la reversión restaura las originales", () => {
    const g149 = fnOf(read("migrations/149_agency_document_responsibility.sql"), "public.app_credential_write_guard");
    const g128 = fnOf(read("migrations/128_shift_reports_caregiver_review.sql"), "app_shift_report_guard");
    const p129 = fnOf(read("migrations/129_shift_reports_family.sql"), "app_shift_report_family_project");
    expect(fnOf(rollback, "public.app_credential_write_guard")).toBe(g149);
    expect(fnOf(rollback, "app_shift_report_guard")).toBe(g128);
    expect(fnOf(rollback, "app_shift_report_family_project")).toBe(p129);
    const now149 = fnOf(mig, "public.app_credential_write_guard");
    expect(now149).toContain("CREDENTIAL_SELF_MANAGEMENT_FORBIDDEN"); // la regla de siempre sigue ahí
    expect(now149).toContain("app_is_independent_operator");
    expect(fnOf(mig, "app_shift_report_guard")).toContain("SHIFT_REPORT_SELF_APPROVAL");
    expect(rollback).toMatch(/ROLLBACK_161_REFUSED/);
  });
  it("la agencia no hereda: un autodeclarado solo le cuenta con SU revisión aprobada", () => {
    const elig = read("src/modules/eligibility/eligibility.service.ts");
    expect(elig).toMatch(/!independent && \(req\.requires_organization_review \|\| credential\.declared_by_holder\)/);
    expect(elig).toMatch(/independent \? SELF_DECLARATION_CONFIRMATION_STATUS : "not_eligible"/);
  });
  it("la confirmación es de la propia persona y queda auditada con el aviso legal", () => {
    const asg = read("src/modules/assignments/assignments.service.ts");
    expect(asg).toMatch(/membership\.user_id === options\.selfDeclarationConfirmedBy/);
    expect(asg).toMatch(/'SELF_DECLARATION_CONFIRMED'/);
    expect(asg).toContain("Esta confirmación no sustituye los requisitos legales que te correspondan.");
  });
  it("el PDF del proveedor nunca dice «Aprobado por la agencia»", () => {
    const pdf = read("src/modules/shiftReports/shiftReportPdf.ts");
    expect(pdf).toMatch(/r\.publishedByProvider\s*\n\s*\? \[\["Proveedor"/);
    expect(pdf).toMatch(/\["Estado", "Informe del proveedor"\]/);
    expect(pdf).toMatch(/r\.publishedByProvider \? "PUBLICADO" : "APROBADO"/);
  });
  it("revisión final de seguridad: cambios de la titular reinician revisiones, evidencia solo suya, sin sondeo, confirmación acotada y nombre obligatorio", () => {
    expect(mig).toMatch(/FUNCTION public\.app_reset_declared_credential_reviews\(p_credential_id uuid\)[\s\S]*SET review_status = 'pending'/);
    expect(fnOf(mig, "public.app_credential_write_guard")).toMatch(/IF TG_OP = 'UPDATE' AND OLD\.declared_by_holder THEN[\s\S]*CREDENTIAL_SELF_DECLARATION_FORBIDDEN[\s\S]*app_reset_declared_credential_reviews/);
    expect(mig).toMatch(/CREATE TRIGGER document_versions_declared_guard BEFORE INSERT ON document_versions/);
    expect(mig).toMatch(/AND p_user_id = NULLIF\(current_setting\('app\.current_user_id', true\), ''\)::uuid/);
    expect(mig).toMatch(/RAISE EXCEPTION 'SELF_DECLARATION_INDEPENDENT_ONLY'/);
    expect(fnOf(mig, "app_shift_report_guard")).toMatch(/RAISE EXCEPTION 'PROVIDER_NAME_REQUIRED'/);
    const ver = read("src/modules/verification/verification.service.ts");
    expect(ver).toMatch(/eligibility\.eligibilityStatus === SELF_DECLARATION_CONFIRMATION_STATUS && Boolean\(assignmentRow\.rows\[0\]\.self_declaration_confirmed_at\)/);
    for (const name of ["app_reset_declared_credential_reviews", "app_declared_document_version_guard", "app_assignment_self_declaration_guard", "assignments_self_declaration_guard", "self_declaration_confirmed_at"])
      expect(rollback).toContain(name);
  });
});
