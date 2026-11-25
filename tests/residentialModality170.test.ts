import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalGatePath, residentialRouteFor, featureCodesForOrganizationType, RESIDENTIAL_DENIED_FEATURES, RESIDENTIAL_ONLY_FEATURES } from "../src/middleware/residentialRules.js";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";
import { teamRouteFor } from "../src/middleware/modalityRules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const mig = read("migrations/170_residential_modality_foundation.sql");
const rollback = read("ops/170_residential_modality_foundation.rollback.sql");
const m157 = read("migrations/157_contracts_per_agency_switch.sql");
const app = read("src/app.ts");
const featuresSrc = read("src/modules/platformOrganizations/platformOrganizationFeatures.ts");
// Leído del código fuente (importar el módulo abriría la base de datos).
const literal = (name: string) => { const i = featuresSrc.indexOf(`const ${name} = [`); return [...featuresSrc.slice(i, featuresSrc.indexOf("as const;", i)).matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]); };
const FEATURE_CODES = [...literal("AGENCY_FEATURE_CODES"), ...literal("RESIDENTIAL_FEATURE_CODES")];
const ID = "11111111-2222-3333-4444-555555555555";
const O = `/organizations/${ID}`;
const ORIGINAL = ["SMARTMATCH", "EN_CAMINO", "ACTIVITY_PHOTOS", "FINANZAS", "FACTURACION", "SHIFT_REPORTS", "PUSH_NOTIFICATIONS", "CONTRACTS"];

describe("170: hogares de envejecientes, F0", () => {
  it("la migración no toca shifts ni datos, y no enciende nada", () => {
    expect(mig).not.toMatch(/ALTER TABLE\s+shifts|UPDATE\s+shifts|ON\s+shifts\b/i);
    expect(mig).not.toMatch(/INSERT INTO organization_features|UPDATE organization_features|DELETE FROM/i);
    expect(mig).not.toMatch(/UPDATE organizations/i);
  });
  it("app_org_is_residential es SECURITY DEFINER, con search_path fijo, sin PUBLIC y solo para app_runtime", () => {
    const fn = mig.slice(mig.indexOf("FUNCTION public.app_org_is_residential"), mig.indexOf("GRANT EXECUTE ON FUNCTION public.app_org_is_residential"));
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path = pg_catalog, public/);
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.app_org_is_residential\(uuid\) FROM PUBLIC;/);
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.app_org_is_residential\(uuid\) TO app_runtime;/);
    expect(mig).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.app_org_feature_modality_guard/);
  });
  it("los CHECK conservan los 8 códigos de la 157 y suman exactamente los 4 de hogar", () => {
    const list = (src: string, table: string) => {
      const i = src.indexOf(`ADD CONSTRAINT ${table}_feature_code_check`);
      return [...src.slice(i, src.indexOf(";", i)).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    };
    for (const t of ["organization_features", "organization_feature_events"]) {
      expect(list(m157, t)).toEqual(ORIGINAL);
      expect(list(mig, t)).toEqual([...ORIGINAL, ...RESIDENTIAL_ONLY_FEATURES]);
      expect(list(rollback, t)).toEqual(ORIGINAL);
    }
    expect(FEATURE_CODES).toEqual([...ORIGINAL, ...RESIDENTIAL_ONLY_FEATURES]);
    expect(featuresSrc).toContain("export const FEATURE_CODES = [...AGENCY_FEATURE_CODES, ...RESIDENTIAL_FEATURE_CODES] as const;");
  });
  it("la guarda solo actúa al encender y cubre ambas direcciones", () => {
    expect(mig).toMatch(/IF NEW\.enabled IS DISTINCT FROM true THEN\s+RETURN NEW;/);
    expect(mig).toMatch(/'HOGAR_CALENDARIO', 'HOGAR_ASIGNACIONES', 'HOGAR_PONCHES', 'DEMO_ENVIRONMENT'\) AND NOT v_residential/);
    expect(mig).toMatch(/'SMARTMATCH', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS'\) AND v_residential/);
    expect(mig).toMatch(/BEFORE INSERT OR UPDATE OF enabled, feature_code, organization_id ON organization_features/);
  });
  it("la reversión se niega si hay interruptores o eventos de hogar y retira todo lo de la 170", () => {
    expect(rollback).toMatch(/ROLLBACK_170_REFUSED/);
    expect(rollback).toMatch(/FROM organization_feature_events/);
    expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.app_org_is_residential\(uuid\);/);
    expect(rollback).toMatch(/DROP TRIGGER IF EXISTS organization_features_modality_guard/);
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '170_residential_modality_foundation\.sql';/);
  });
  it("/residential existe solo como ruta de hogar (cualquier método, sin distinción de mayúsculas)", () => {
    for (const p of [`${O}/residential`, `${O}/residential/overview`, `/ORGANIZATIONS/${ID.toUpperCase()}/Residential/x`])
      expect(residentialRouteFor(p)).toEqual({ organizationId: ID, kind: "residential" });
    expect(residentialRouteFor(`${O}/residentialx`)).toBeNull();
  });
  it("lista denegada: toda ruta de SmartMatch, Finanzas, Facturación e Informe de Turno de orgFeatureRules queda cubierta", () => {
    const samples = ["/smartmatch", "/smartmatch/opportunities", `/shifts/${ID}/private-instructions`, "/finance", "/finance/services", `/shifts/${ID}/finance`,
      "/billing", "/billing/access", "/shift-reports", `/shift-reports/${ID}/approve`, `/shifts/${ID}/shift-reports`, "/shift-report-access", "/shift-report-reviewers",
      "/me/shift-reports", `/care-recipients/${ID}/shift-reports`];
    const denied = RESIDENTIAL_DENIED_FEATURES as readonly string[];
    for (const s of samples) {
      for (const m of ["GET", "POST", "PATCH", "DELETE"]) {
        const g = gatedFeatureFor(`${O}${s}`, m);
        expect(g && denied.includes(g.feature)).toBeTruthy();
        expect(residentialRouteFor(`${O}${s}`)?.kind).toBe("denied");
      }
    }
  });
  it("lo que no es de esos módulos no pasa por la lista denegada (residentes, turnos, contratos, fotos, establecimientos)", () => {
    for (const s of ["/care-recipients", `/care-recipients/${ID}`, "/shifts", `/shifts/${ID}/assignments`, "/contracts", "/activity-photos", "/establishments", "/team", "/workers", "/timesheets", "/financial-rates"])
      expect(residentialRouteFor(`${O}${s}`)).toBeNull();
  });
  it("las reglas de independientes (160) no cambian", () => {
    expect(teamRouteFor(`${O}/smartmatch/x`, "GET")).not.toBeNull();
    expect(teamRouteFor(`${O}/residential/overview`, "GET")).toBeNull();
  });
  it("Central: agencias e independientes ven la lista de siempre; el hogar, la suya", () => {
    expect(featureCodesForOrganizationType(FEATURE_CODES, "HOME_CARE_AGENCY")).toEqual(ORIGINAL);
    expect(featureCodesForOrganizationType(FEATURE_CODES, "INDEPENDENT_PROVIDER")).toEqual(ORIGINAL);
    expect(featureCodesForOrganizationType(FEATURE_CODES, "RESIDENTIAL_CARE_HOME")).toEqual(["EN_CAMINO", "ACTIVITY_PHOTOS", "PUSH_NOTIFICATIONS", "CONTRACTS", ...RESIDENTIAL_ONLY_FEATURES]);
  });
  it("residentialGate va justo después de modalityGate y antes de orgFeatureGate", () => {
    expect(app).toContain("app.use(modalityGate);app.use(residentialGate);app.use(orgFeatureGate);");
    expect(app).toContain("app.use(residentialRoutes);");
  });
});

// Revisión independiente 25-nov (A1): variantes que Express 5 acepta (barra final, mayúsculas, %XX en ids y literales).
describe("170 A1 · la guarda reconoce todas las variantes de ruta que Express acepta", () => {
  const ID2 = "0b8f2c1e-6a4d-4c3b-9e2f-1a2b3c4d5e6f";
  const enc = (s: string) => [...s].map((c) => "%" + c.charCodeAt(0).toString(16)).join("");
  it("forma canónica: decodifica segmentos, quita barras repetidas y finales, nunca lanza", () => {
    expect(canonicalGatePath(`/organizations/%61bc//finance/`)).toBe("/organizations/abc/finance");
    expect(canonicalGatePath("/a/%E0%A4%A/b")).toBe("/a/%e0%a4%a/b");
    expect(canonicalGatePath("/")).toBe("/");
  });
  const denied = ["/smartmatch/opportunities", `/shifts/${ID2}/private-instructions`, "/finance/services", `/shifts/${ID2}/finance`, "/billing/invoices",
    "/shift-reports", `/shifts/${ID2}/shift-reports`, "/shift-report-reviewers", "/me/shift-reports", `/care-recipients/${ID2}/shift-reports`];
  it("rutas denegadas: barra final, doble barra, mayúsculas, ids y literales codificados → denied con el id decodificado", () => {
    for (const s of denied) {
      const variants = [`${O}${s}/`, `${O}${s}//`, `${O}/${s}`, `${O}${s}`.toUpperCase() + "/", `/organizations/${enc(ID)}${s}`,
        `/organizations/%${ID.charCodeAt(0).toString(16)}${ID.slice(1)}${s}`, `${O}${s.replace(/\/([a-z])/, (_m, c: string) => "/%" + c.charCodeAt(0).toString(16))}`,
        `${O}${s.replace(ID2, enc(ID2))}`];
      for (const v of variants) expect(residentialRouteFor(v), v).toEqual({ organizationId: ID, kind: "denied" });
    }
  });
  it("/residential con las mismas variantes → residential", () => {
    for (const v of [`${O}/residential/overview/`, `/organizations/${enc(ID)}/residential/overview`, `${O}/%72esidential/overview`, `${O}//residential`])
      expect(residentialRouteFor(v), v).toEqual({ organizationId: ID, kind: "residential" });
  });
  it("sin falsos positivos: otras rutas y nombres parecidos siguen sin regla", () => {
    for (const s of ["/financial-rates", "/finances", "/billingx", "/smartmatches", "/residentialx", `/shifts/${ID2}/financex`, "/care-recipients"])
      expect(residentialRouteFor(`${O}${s}/`), s).toBeNull();
  });
});

// Revisión independiente 25-nov (A2): la guarda se cierra ante cualquier fallo inesperado.
describe("170 A2 · residentialGate se cierra ante lo inesperado", () => {
  const gateSrc = read("src/middleware/residentialGate.ts");
  it("solo continúa con sesión inválida (401 de la ruta); pertenencia → 403; id inválido → 400; lo demás → 503", () => {
    expect(gateSrc).toMatch(/if \(error instanceof SessionInvalidError\) \{ next\(\); return; \}\s*unavailable\(res, "session", error\)/);
    expect(gateSrc).toMatch(/isTenantAccessDenied\(error\)\) \{ res\.status\(403\)/);
    expect(gateSrc).toMatch(/InvalidTenantContextError\) \{ res\.status\(400\)/);
    expect(gateSrc).toMatch(/unavailable\(res, "modality", error\); return;/);
    expect(gateSrc).not.toMatch(/=== "42883"/);
    // La consulta de modalidad corre dentro del contexto de la organización (misma transacción).
    expect(gateSrc).toMatch(/withTenantContext\(\{ userId, organizationId: route\.organizationId \}, async \(trx\) =>[\s\S]*app_org_is_residential[\s\S]*\.execute\(trx\)/);
    // next() solo aparece en: OPTIONS, sin regla o sin token, sesión inválida y el final permitido.
    expect((gateSrc.match(/next\(\)/g) ?? []).length).toBe(4);
  });
});

