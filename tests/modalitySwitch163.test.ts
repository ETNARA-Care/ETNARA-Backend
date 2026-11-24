import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { modalityActivationAllowed, setModalitySchema } from "../src/modules/platformOrganizations/platformModalityRules.js";

const strip = (s: string) => s.replace(/--.*$/gm, "");
const m163 = strip(readFileSync("migrations/163_platform_modality_switch_central.sql", "utf8"));
const rollback = strip(readFileSync("ops/163_platform_modality_switch_central.rollback.sql", "utf8"));

describe("163 · Central switch for the independent caregiver modality", () => {
  afterEach(() => { delete process.env.INDEPENDENT_MODALITY_ACTIVATION_ALLOWED; });

  it("activation is off unless the server variable is exactly 'on'", () => {
    expect(modalityActivationAllowed()).toBe(false);
    for (const v of ["true", "1", "ON", "yes", ""]) { process.env.INDEPENDENT_MODALITY_ACTIVATION_ALLOWED = v; expect(modalityActivationAllowed()).toBe(false); }
    process.env.INDEPENDENT_MODALITY_ACTIVATION_ALLOWED = "on";
    expect(modalityActivationAllowed()).toBe(true);
  });

  it("requires a boolean state and a 10–1000 character reason", () => {
    expect(setModalitySchema.safeParse({ enabled: true }).success).toBe(false);
    expect(setModalitySchema.safeParse({ enabled: true, reason: "corto" }).success).toBe(false);
    expect(setModalitySchema.safeParse({ enabled: "true", reason: "un motivo válido" }).success).toBe(false);
    expect(setModalitySchema.safeParse({ enabled: false, reason: "un motivo válido" }).success).toBe(true);
  });

  it("never turns the modality on and keeps the runtime away from the table", () => {
    expect(m163).not.toMatch(/UPDATE\s+platform_modalities\s+SET\s+enabled\s*=\s*true/i);
    expect(m163).not.toMatch(/GRANT[^;]*ON platform_modalities/i);
    expect(m163).toMatch(/app_is_superadmin\(\)/);
    expect(m163).toMatch(/BEFORE UPDATE OR DELETE ON platform_modality_events/);
  });

  it("second lock: enabling needs a single-use, expiring authorization created only by operations", () => {
    expect(m163).toMatch(/CREATE TRIGGER platform_modalities_activation_lock\s+BEFORE INSERT OR UPDATE OF enabled ON platform_modalities/);
    expect(m163).toMatch(/RAISE EXCEPTION 'MODALITY_ACTIVATION_LOCKED'/);
    expect(m163).toMatch(/REVOKE ALL ON FUNCTION public\.app_ops_authorize_modality_activation\(text, text, text, integer\) FROM app_runtime/);
    expect(m163).toMatch(/expires_at <= created_at \+ interval '24 hours'/);
    expect(m163).toMatch(/SET consumed_at = now\(\)/);
    expect(rollback).toMatch(/DROP TRIGGER IF EXISTS platform_modalities_activation_lock/);
  });

  it("rollback keeps the modality state and the audit records", () => {
    expect(rollback).not.toMatch(/platform_modalities\s+SET/i);
    expect(rollback).not.toMatch(/^\s*DROP TABLE/m);
  });
});
