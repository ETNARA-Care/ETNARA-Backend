import { describe, expect, it } from "vitest";
import { smartMatchPublishSchema } from "../src/modules/smartmatch/smartmatch.schemas.js";
import { isSafeRoleLabel, SMARTMATCH_ROLE_OPTIONS } from "../src/modules/smartmatch/smartmatch.privacy.js";
import { PUERTO_RICO_MUNICIPALITIES } from "../src/modules/smartmatch/smartmatch.municipalities.js";

const base = {
  visibility: "INTERNAL",
  regionLabel: "Caguas",
  roleLabel: "Cuidador/a",
  startsAt: "2026-11-21T12:00:00.000Z",
  endsAt: "2026-11-21T16:00:00.000Z",
};
const ok = (patch: Record<string, unknown>) => smartMatchPublishSchema.safeParse({ ...base, ...patch }).success;

describe("SmartMatch Gate 5: opportunity privacy validation", () => {
  it("has exactly the 78 municipalities", () => {
    expect(PUERTO_RICO_MUNICIPALITIES).toHaveLength(78);
    expect(new Set(PUERTO_RICO_MUNICIPALITIES).size).toBe(78);
  });

  it("accepts every predefined role and every municipality", () => {
    for (const role of SMARTMATCH_ROLE_OPTIONS) expect(ok({ roleLabel: role })).toBe(true);
    for (const town of PUERTO_RICO_MUNICIPALITIES) expect(ok({ regionLabel: town })).toBe(true);
  });

  it("rejects anything that is not a municipality (addresses, neighbourhoods)", () => {
    for (const region of ["Calle Luna 123, San Juan", "Urb. Las Lomas", "San Juan 00926", "Condado", "caguas "]) {
      expect(ok({ regionLabel: region }), region).toBe(false);
    }
  });

  it("accepts reasonable free-text job titles ('Otro')", () => {
    for (const role of ["Cuidador", "Auxiliar de cuidado (fin de semana)", "Acompañante bilingüe", "Cuidador/a de relevo"]) {
      expect(isSafeRoleLabel(role), role).toBe(true);
    }
  });

  it("rejects names, phones, e-mails, addresses and clinical words in the role", () => {
    for (const role of [
      "Cuidar a Sra. Rivera",
      "Don Pedro",
      "Llamar 787-555-0100",
      "contacto@example.com",
      "Calle Sol, apartamento 2",
      "Urb. Las Lomas",
      "Paciente con demencia",
      "Diálisis martes",
      "Cuidador #2",
      "<script>",
      "x".repeat(61),
    ]) {
      expect(isSafeRoleLabel(role), role).toBe(false);
      expect(ok({ roleLabel: role }), role).toBe(false);
    }
  });
});
