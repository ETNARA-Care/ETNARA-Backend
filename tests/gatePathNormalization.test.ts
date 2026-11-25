// Seguridad 25-nov-2026: normalización común de rutas para las guardas y su comportamiento ante fallos.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ session: null as null | (() => Promise<{ userId: string }>), tenant: null as null | (() => Promise<unknown>), feature: true, independent: false }));
vi.mock("../src/modules/auth/auth.service.js", () => { class SessionInvalidError extends Error {} return { SessionInvalidError, validateSessionToken: vi.fn(() => state.session!()) }; });
vi.mock("../src/context/tenantContext.js", () => ({ withTenantContext: vi.fn(() => state.tenant!()) }));
vi.mock("../src/security/tenantAccessDenied.js", () => { class AccessDenied extends Error {} return { AccessDenied, isTenantAccessDenied: (e: unknown) => e instanceof AccessDenied, TENANT_ACCESS_DENIED_BODY: { error: "ORGANIZATION_ACCESS_DENIED" } }; });
vi.mock("../src/config/db.js", () => ({ db: {} }));
vi.mock("kysely", () => ({ sql: () => ({ execute: async () => ({ rows: [{ enabled: state.feature, independent: state.independent }] }) }) }));

const { canonicalGatePath, gatePathCandidates } = await import("../src/middleware/gatePath.js");
const { gatedFeatureFor } = await import("../src/middleware/orgFeatureRules.js");
const { teamRouteFor } = await import("../src/middleware/modalityRules.js");
const { orgFeatureGate } = await import("../src/middleware/orgFeatureGate.js");
const { modalityGate } = await import("../src/middleware/modalityGate.js");
const { SessionInvalidError } = (await import("../src/modules/auth/auth.service.js")) as unknown as { SessionInvalidError: new (m?: string) => Error };
const { AccessDenied } = (await import("../src/security/tenantAccessDenied.js")) as unknown as { AccessDenied: new () => Error };
const { InvalidTenantContextError } = await import("../src/context/errors.js");

const ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", ID2 = "0b8f2c1e-6a4d-4c3b-9e2f-1a2b3c4d5e6f";
const encAll = (s: string) => [...s].map((c) => "%" + c.charCodeAt(0).toString(16)).join("");
const variants = (p: string) => [p + "/", p + "//", p.toUpperCase(), p.toUpperCase() + "/", p.replace(ID, encAll(ID)), p.replace(ID, "%" + ID.charCodeAt(0).toString(16) + ID.slice(1)), p.replace(`/organizations/${ID}/`, `/organizations/${ID}//`)];

describe("canonicalGatePath", () => {
  it("decodifica segmentos, quita barras repetidas y finales, pasa a minúsculas y nunca lanza", () => {
    expect(canonicalGatePath(`/Organizations/%61BC//Finance/`)).toBe("/organizations/abc/finance");
    expect(canonicalGatePath("/a/%E0%A4%A/b")).toBe("/a/%e0%a4%a/b");
    expect(canonicalGatePath("/")).toBe("/");
    expect(gatePathCandidates("/organizations/x/finance")).toEqual(["/organizations/x/finance"]);
    expect(gatePathCandidates("/organizations/x/finance/")).toEqual(["/organizations/x/finance", "/organizations/x/finance/"]);
  });
});

describe("reglas: las variantes que Express acepta dan la misma decisión que la ruta canónica", () => {
  const featurePaths = [`/smartmatch/opportunities`, `/shifts/${ID2}/private-instructions`, `/finance/services`, `/shifts/${ID2}/finance`, `/billing/invoices`,
    `/shift-reports`, `/shifts/${ID2}/shift-reports`, `/care-events/${ID2}/photo`, `/activity-photos/${ID2}/legal-hold`, `/contracts/acceptances`, `/me/location-consent`];
  it("orgFeatureRules", () => {
    for (const s of featurePaths) for (const m of ["GET", "POST", "PUT", "HEAD"]) {
      const canonical = gatedFeatureFor(`/organizations/${ID}${s}`, m);
      expect(canonical, s).not.toBeNull();
      for (const v of variants(`/organizations/${ID}${s}`)) expect(gatedFeatureFor(v, m), `${m} ${v}`).toEqual(canonical);
    }
  });
  it("modalityRules (incluidas las reglas que terminan en $: workers, compliance/audit…)", () => {
    for (const [s, m] of [["/team", "GET"], ["/workers", "POST"], [`/workers/${ID2}`, "PATCH"], ["/credentials/review-queue", "GET"], ["/compliance/audit", "GET"], ["/my-agency-conversation", "GET"], [`/timesheets/${ID2}/review`, "POST"]] as const) {
      const canonical = teamRouteFor(`/organizations/${ID}${s}`, m);
      expect(canonical, s).toEqual({ organizationId: ID });
      for (const v of variants(`/organizations/${ID}${s}`)) expect(teamRouteFor(v, m), `${m} ${v}`).toEqual(canonical);
    }
  });
  it("sin cambio de reglas: lo que antes no estaba cerrado sigue sin regla (también con variantes)", () => {
    for (const [s, m] of [["/workers", "GET"], [`/workers/${ID2}/credentials`, "POST"], ["/compliance/configuration", "GET"], [`/workers/${ID2}/compliance`, "GET"], ["/care-recipients", "POST"], ["/financial-ratesx", "GET"]] as const)
      for (const v of [`/organizations/${ID}${s}`, ...variants(`/organizations/${ID}${s}`)]) expect(teamRouteFor(v, m), `${m} ${v}`).toBeNull();
    for (const v of [`/organizations/${ID}/care-recipients/`, `/organizations/${ID}/finances`, `/organizations/${ID}/billingx/`]) expect(gatedFeatureFor(v, "GET"), v).toBeNull();
  });
});

async function run(gate: typeof orgFeatureGate, path: string, method = "GET", auth = "Bearer t") {
  const out = { status: 0, body: undefined as unknown, next: false };
  const res = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; } };
  await gate({ method, path, headers: { authorization: auth } } as never, res as never, () => { out.next = true; });
  return out;
}
const pgError = (code: string) => Object.assign(new Error("secreto"), { code });

describe("orgFeatureGate y modalityGate: cerrados ante lo inesperado", () => {
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); state.session = async () => ({ userId: ID }); state.tenant = async () => true; state.feature = false; state.independent = true; });
  for (const [name, gate, path, unavailable, blocked] of [
    ["orgFeatureGate", orgFeatureGate, `/organizations/%${ID.charCodeAt(0).toString(16)}${ID.slice(1)}/finance/services/`, "FEATURE_CHECK_UNAVAILABLE", { status: 404, body: { error: "FEATURE_NOT_ENABLED" } }],
    ["modalityGate", modalityGate, `/ORGANIZATIONS/${encAll(ID)}/TEAM/`, "MODALITY_CHECK_UNAVAILABLE", { status: 403, body: { error: "MODALITY_NOT_AVAILABLE" } }],
  ] as const) {
    it(`${name}: variante cerrada; sesión inválida sigue (401 de la ruta); no miembro 403; id inválido 400; lo demás 503`, async () => {
      expect(await run(gate, path)).toMatchObject({ ...blocked, next: false });
      state.session = async () => { throw new SessionInvalidError("SESSION_EXPIRED"); };
      expect(await run(gate, path)).toMatchObject({ next: true, status: 0 });
      for (const code of ["57P01", "42501", "08006"]) { state.session = async () => { throw pgError(code); }; expect(await run(gate, path), code).toMatchObject({ status: 503, body: { error: unavailable }, next: false }); }
      state.session = async () => ({ userId: ID });
      state.tenant = async () => { throw new AccessDenied(); };
      expect(await run(gate, path)).toMatchObject({ status: 403, body: { error: "ORGANIZATION_ACCESS_DENIED" }, next: false });
      state.tenant = async () => { throw new InvalidTenantContextError("x"); };
      expect(await run(gate, path)).toMatchObject({ status: 400, body: { error: "INVALID_ORGANIZATION_ID" }, next: false });
      for (const code of ["42883", "42501", "57014", "XX000"]) { state.tenant = async () => { throw pgError(code); }; expect(await run(gate, path), code).toMatchObject({ status: 503, body: { error: unavailable }, next: false }); }
    });
  }
  it("el registro de errores lleva solo la guarda, la etapa y el código", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.tenant = async () => { throw pgError("42501"); };
    await run(orgFeatureGate, `/organizations/${ID}/finance`);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secreto/);
    expect(spy).toHaveBeenCalledWith("GATE_UNAVAILABLE", { gate: "orgFeatureGate", stage: "check", code: "42501" });
  });
});
