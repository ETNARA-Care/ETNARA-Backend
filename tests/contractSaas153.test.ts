import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { contractsEnforcementEnabled, decideContractGate, MIN_NOTICE_DAYS, type GateInput } from "../src/modules/contracts/contracts.enforcement.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("migrations/153_contract_saas_v1.sql");
const rollback = read("ops/153_contract_saas_v1.rollback.sql");
const O = "/organizations/11111111-1111-4111-8111-111111111111";
const past = new Date(Date.now() - 60_000);
const base: GateInput = { mode: "restrict_new_operations", enforceFrom: past, satisfied: false, roles: ["ORGANIZATION_ADMIN"], method: "POST", path: `${O}/shifts`, now: new Date() };
const gate = (o: Partial<GateInput>) => decideContractGate({ ...base, ...o }).allow;

describe("153 contrato SaaS — reglas de acceso (preparadas y apagadas)", () => {
  afterEach(() => { delete process.env.CONTRACTS_ENFORCEMENT; });

  it("el interruptor global está apagado salvo CONTRACTS_ENFORCEMENT=on exacto", () => {
    expect(contractsEnforcementEnabled()).toBe(false);
    process.env.CONTRACTS_ENFORCEMENT = "true";
    expect(contractsEnforcementEnabled()).toBe(false);
    process.env.CONTRACTS_ENFORCEMENT = "on";
    expect(contractsEnforcementEnabled()).toBe(true);
  });

  it("nunca bloquea si la agencia cumple, si el modo es off o aviso, o antes de la fecha", () => {
    expect(gate({ satisfied: true })).toBe(true);
    expect(gate({ mode: "off" })).toBe(true);
    expect(gate({ mode: "notice" })).toBe(true);
    expect(gate({ enforceFrom: null })).toBe(true);
    expect(gate({ enforceFrom: new Date(Date.now() + 86_400_000) })).toBe(true);
  });

  it("cuidadores, familiares y sin rol nunca se bloquean", () => {
    for (const roles of [["WORKER"], ["FAMILY"], []]) {
      expect(gate({ roles })).toBe(true);
      expect(gate({ roles, mode: "contract_only", path: `${O}/shifts/x/check-in` })).toBe(true);
    }
  });

  it("lecturas y el propio proceso contractual siempre pasan", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(gate({ method, mode: "contract_only" })).toBe(true);
    expect(gate({ mode: "contract_only", path: `${O}/contracts/versions/v/accept` })).toBe(true);
    expect(gate({ path: `${O}/contracts/versions/v/signature-code` })).toBe(true);
  });

  it("«restringir operación nueva» bloquea solo abrir operación nueva (POST en la lista)", () => {
    for (const p of ["/shifts", "/care-recipients", "/establishments", "/establishments/e/residents", "/establishments/e/shifts", "/workers", "/access-invitations", "/team/invitations", "/smartmatch/opportunities", "/smartmatch/opportunities/o/publish", "/billing/invoices", "/billing/invoices/i/issue"]) {
      expect(gate({ path: O + p })).toBe(false);
    }
    expect(gate({ roles: ["SUPERVISOR"] })).toBe(false);
    // Continuidad: turnos existentes y en curso, registros, incidentes, mensajes, ediciones.
    for (const p of ["/shifts/s/check-in", "/shifts/s/check-out", "/shifts/s/incidents", "/conversations/c/messages", "/care-recipients/r/notes"]) expect(gate({ path: O + p })).toBe(true);
    expect(gate({ method: "PATCH", path: `${O}/shifts/s` })).toBe(true);
    expect(gate({ method: "DELETE", path: `${O}/shifts/s` })).toBe(true);
  });

  it("«solo contrato» bloquea cualquier escritura de gestión fuera de /contracts", () => {
    expect(gate({ mode: "contract_only", method: "PATCH", path: `${O}/settings` })).toBe(false);
    expect(gate({ mode: "contract_only", method: "POST", path: `${O}/anything` })).toBe(false);
  });

  it("el aviso mínimo para agencias que ya operan es de 30 días", () => {
    expect(MIN_NOTICE_DAYS).toBe(30);
  });

  it("la migración fija los textos de las casillas y exige aprobación jurídica ligada a la huella", () => {
    expect(migration).toContain("He leído el contrato completo, tuve oportunidad de descargarlo y acepto sus términos.");
    expect(migration).toContain("Declaro que tengo autoridad legal suficiente para representar y obligar contractualmente a esta agencia.");
    expect(migration).toContain("CONTRACT_LEGAL_APPROVAL_REQUIRED");
    expect(migration).toMatch(/legal_approved_sha256/);
    expect(migration).not.toMatch(/INSERT INTO organization_contract_enforcement/i); // ninguna regla se crea sola
  });

  it("la reversión se niega con evidencia oficial y restaura el texto de 152", () => {
    expect(rollback).toContain("CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE");
    expect(rollback).toContain("Declaro que tengo autoridad suficiente para aceptar este documento en nombre de la organización");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE filename = '153_contract_saas_v1.sql'");
  });
});
