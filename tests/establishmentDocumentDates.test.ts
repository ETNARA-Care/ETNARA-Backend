import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertDocumentDatesCoherent,
  InvalidDocumentDatesError,
  normalizeDocumentDates,
  todayInPuertoRico,
} from "../src/modules/establishmentDocuments/establishmentDocumentDates.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const NOW = new Date("2026-11-05T15:00:00Z");
const reason = (fn: () => unknown) => {
  try { fn(); return "ok"; } catch (e) { return e instanceof InvalidDocumentDatesError ? `${e.field}:${e.reason}` : "other"; }
};

describe("D4 institutional document dates", () => {
  it("accepts real dates, «none» and empty values", () => {
    expect(normalizeDocumentDates({ issuedOn: "2026-01-15", expiresOn: "2027-01-15" }, NOW)).toEqual({ issuedOn: "2026-01-15", expiry: { expiresOn: "2027-01-15", notApplicable: false } });
    // 150: «sin vencimiento aplicable» es una marca explícita, nunca una fecha artificial.
    expect(normalizeDocumentDates({ expiresOn: "none" }, NOW)).toEqual({ issuedOn: undefined, expiry: { expiresOn: null, notApplicable: true } });
    expect(normalizeDocumentDates({ issuedOn: "", expiresOn: null }, NOW)).toEqual({ issuedOn: null, expiry: { expiresOn: null, notApplicable: false } });
    expect(normalizeDocumentDates({}, NOW)).toEqual({ issuedOn: undefined, expiry: undefined });
    expect(normalizeDocumentDates({ expiresOn: "2020-01-01" }, NOW).expiry?.expiresOn).toBe("2020-01-01"); // already expired is valid
  });

  it("rejects bad formats, impossible dates, future issue and ranges", () => {
    expect(reason(() => normalizeDocumentDates({ issuedOn: "15/01/2026" }, NOW))).toBe("issuedOn:FORMAT");
    expect(reason(() => normalizeDocumentDates({ expiresOn: "2027-02-30" }, NOW))).toBe("expiresOn:FORMAT");
    expect(reason(() => normalizeDocumentDates({ issuedOn: "2026-11-06" }, NOW))).toBe("issuedOn:FUTURE_ISSUE");
    expect(reason(() => normalizeDocumentDates({ issuedOn: "1899-12-31" }, NOW))).toBe("issuedOn:OUT_OF_RANGE");
    expect(reason(() => normalizeDocumentDates({ expiresOn: "9999-12-31" }, NOW))).toBe("expiresOn:OUT_OF_RANGE");
  });

  it("checks chronology, except for «no expiry»", () => {
    expect(reason(() => assertDocumentDatesCoherent("2026-05-01", "2026-04-30"))).toBe("expiresOn:EXPIRES_BEFORE_ISSUED");
    expect(reason(() => assertDocumentDatesCoherent("2026-05-01", "2026-05-01"))).toBe("ok");
    expect(reason(() => assertDocumentDatesCoherent("2026-05-01", null))).toBe("ok");
    expect(reason(() => assertDocumentDatesCoherent(null, "2020-01-01"))).toBe("ok");
  });

  it("uses Puerto Rico's calendar day", () => {
    expect(todayInPuertoRico(new Date("2026-11-06T02:00:00Z"))).toBe("2026-11-05");
  });

  it("dates correction keeps 149: archives + inserts a version, never updates other columns", () => {
    const service = read("src/modules/establishmentDocuments/establishmentDocuments.service.ts");
    const fn = service.slice(service.indexOf("export async function correctEstablishmentDocumentDates"));
    expect(fn).toContain("await allowed(trx,o,e)");
    expect(fn).toContain("withTenantContext");
    expect(fn).not.toContain("app_is_superadmin");
    expect(fn).toMatch(/UPDATE establishment_documents SET archived_at=now\(\),updated_at=now\(\) WHERE/);
    expect(fn).not.toMatch(/SET (issued_on|expires_on|review_status|storage_key)/);
    expect(fn).toContain("copyPrivateObject(current.storage_key,key)");
    expect(fn).toContain("'ESTABLISHMENT_DOCUMENT_DATES_CORRECTED'");
    expect(fn).toMatch(/catch\(err\)\{if\(copiedKey\)await removeUploadedObject\(copiedKey\);throw err;\}/);
    expect(fn).toContain("expiry_not_applicable");
    const storage = read("src/modules/storage/objectStorage.ts");
    expect(storage).toContain("CopyObjectCommand");
  });
});

describe("150: explicit «no expiry» flag, no artificial dates", () => {
  it("adds one defaulted column + a check, touches no row and leaves 149 alone", () => {
    const m = read("migrations/150_establishment_document_expiry.sql").replace(/--.*$/gm, "");
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS expiry_not_applicable boolean NOT NULL DEFAULT false/);
    expect(m).toMatch(/CHECK \(NOT expiry_not_applicable OR expires_on IS NULL\)/);
    expect(m).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bINSERT\b|GRANT|REVOKE|POLICY|TRIGGER|9999/);
    const rb = read("ops/150_establishment_document_expiry.rollback.sql");
    expect(rb).toMatch(/DROP COLUMN IF EXISTS expiry_not_applicable/);
    expect(rb).toMatch(/DELETE FROM schema_migrations WHERE filename = '150_establishment_document_expiry.sql'/);
    for (const f of ["src/modules/establishmentDocuments/establishmentDocuments.service.ts", "src/modules/establishmentDocuments/establishmentDocumentDates.ts"]) expect(read(f)).not.toContain("9999");
  });
});
