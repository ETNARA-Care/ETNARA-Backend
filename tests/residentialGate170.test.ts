// 170 · revisión independiente 25-nov (A2): comportamiento real de residentialGate ante cada clase de error.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ session: null as null | (() => Promise<{ userId: string }>), tenant: null as null | (() => Promise<boolean>) }));
vi.mock("../src/modules/auth/auth.service.js", () => {
  class SessionInvalidError extends Error {}
  return { SessionInvalidError, validateSessionToken: vi.fn(() => state.session!()) };
});
vi.mock("../src/context/tenantContext.js", () => ({ withTenantContext: vi.fn(() => state.tenant!()) }));
vi.mock("../src/security/tenantAccessDenied.js", () => {
  class AccessDenied extends Error {}
  return { AccessDenied, isTenantAccessDenied: (e: unknown) => e instanceof AccessDenied, TENANT_ACCESS_DENIED_BODY: { error: "ORGANIZATION_ACCESS_DENIED" } };
});
vi.mock("../src/config/db.js", () => ({ db: {} }));

const { residentialGate } = await import("../src/middleware/residentialGate.js");
const { SessionInvalidError } = (await import("../src/modules/auth/auth.service.js")) as unknown as { SessionInvalidError: new (m?: string) => Error };
const { AccessDenied } = (await import("../src/security/tenantAccessDenied.js")) as unknown as { AccessDenied: new () => Error };
const { InvalidTenantContextError } = await import("../src/context/errors.js");

const ORG = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
async function run(path: string, auth = "Bearer t", method = "GET") {
  const out = { status: 0, body: undefined as unknown, next: false };
  const res = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; } };
  await residentialGate({ method, path, headers: { authorization: auth } } as never, res as never, () => { out.next = true; });
  return out;
}
const pgError = (code: string) => Object.assign(new Error("x"), { code });

describe("residentialGate (A2): cerrado ante lo inesperado", () => {
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); state.session = async () => ({ userId: ORG }); state.tenant = async () => true; });
  it("hogar en ruta denegada → 403 MODALITY_NOT_AVAILABLE; agencia → continúa", async () => {
    expect(await run(`/organizations/${ORG}/finance/services/`)).toMatchObject({ status: 403, body: { error: "MODALITY_NOT_AVAILABLE" }, next: false });
    state.tenant = async () => false;
    expect(await run(`/organizations/${ORG}/finance/services`)).toMatchObject({ status: 0, next: true });
    expect(await run(`/organizations/${ORG}/residential/overview`)).toMatchObject({ status: 403, body: { error: "MODALITY_NOT_AVAILABLE" } });
  });
  it("sesión inválida → continúa (la ruta responde 401); fallo inesperado de sesión → 503", async () => {
    state.session = async () => { throw new SessionInvalidError("SESSION_REVOKED"); };
    expect(await run(`/organizations/${ORG}/finance/services`)).toMatchObject({ next: true, status: 0 });
    for (const err of [pgError("57P01"), pgError("42501"), new Error("ECONNREFUSED"), pgError("08006")]) {
      state.session = async () => { throw err; };
      expect(await run(`/organizations/${ORG}/finance/services`)).toMatchObject({ status: 503, body: { error: "MODALITY_CHECK_UNAVAILABLE" }, next: false });
    }
  });
  it("no miembro → 403 ORGANIZATION_ACCESS_DENIED; id inválido → 400; cualquier otro error (incluido 42883) → 503", async () => {
    state.tenant = async () => { throw new AccessDenied(); };
    expect(await run(`/organizations/${ORG}/billing`)).toMatchObject({ status: 403, body: { error: "ORGANIZATION_ACCESS_DENIED" }, next: false });
    state.tenant = async () => { throw new InvalidTenantContextError("bad"); };
    expect(await run(`/organizations/${ORG}/billing`)).toMatchObject({ status: 400, body: { error: "INVALID_ORGANIZATION_ID" }, next: false });
    for (const code of ["42883", "42501", "57014", "40001", "53300", "XX000"]) {
      state.tenant = async () => { throw pgError(code); };
      for (const p of [`/organizations/${ORG}/billing`, `/organizations/${ORG}/residential/overview`])
        expect(await run(p), `${code} ${p}`).toMatchObject({ status: 503, body: { error: "MODALITY_CHECK_UNAVAILABLE" }, next: false });
    }
  });
  it("rutas sin regla, OPTIONS y peticiones sin token: continúan sin consultar nada", async () => {
    state.session = async () => { throw new Error("no debería llamarse"); };
    expect(await run(`/organizations/${ORG}/care-recipients`)).toMatchObject({ next: true });
    expect(await run(`/organizations/${ORG}/finance`, "Bearer t", "OPTIONS")).toMatchObject({ next: true });
    expect(await run(`/organizations/${ORG}/finance`, "")).toMatchObject({ next: true });
  });
  it("el registro de errores lleva solo la etapa y el código, nunca el mensaje", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.tenant = async () => { throw Object.assign(new Error("secreto: correo@ejemplo"), { code: "42501" }); };
    await run(`/organizations/${ORG}/finance`);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secreto|correo/);
    expect(spy).toHaveBeenCalledWith("RESIDENTIAL_GATE_UNAVAILABLE", { stage: "modality", code: "42501" });
  });
});
