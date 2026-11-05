/**
 * Elegibilidad por política de la agencia (decisión 4-nov-2026): cada agencia define los
 * requisitos de cada puesto; ETNARA no impone una lista universal. Verifica en una base
 * desechable, como app_runtime y con datos ficticios, que:
 *  - sin política aplicable la persona queda bloqueada ("unconfigured") y la asignación falla;
 *  - con política, el estado se calcula solo con los requisitos configurados y al instante;
 *  - cada motivo (falta, vencida, no activa, pendiente, rechazada) se conserva.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=... DATABASE_URL=app_runtime@... npx tsx scripts/verifyEligibilityPolicyStates.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
const admin = new pg.Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
if (process.env.ETNARA_DISPOSABLE_DB !== "true" || /railway|rlwy/i.test(process.env.MIGRATIONS_DATABASE_URL ?? "")) throw new Error("solo base desechable");
const tag = randomUUID().slice(0, 8);
const q = (t: string, p: unknown[] = []) => admin.query(t, p);

async function main() {
  await admin.connect();
  const { createOrUpdateOrganizationReview } = await import("../src/modules/credentialing/credentialing.service.js");
  const { getComplianceSummary, evaluateWorkerEligibility, NoApplicableRequirementSetError } = await import("../src/modules/eligibility/eligibility.service.js");
  const { closeDb } = await import("../src/config/db.js");
  const adminRole = (await q(`SELECT id FROM roles WHERE code='ORGANIZATION_ADMIN'`)).rows[0].id;
  const typeId = async (code: string) => (await q(`SELECT id FROM credential_types WHERE code=$1`, [code])).rows[0].id as string;
  let n = 0;

  async function agency(label: string) {
    n++;
    const org = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`Agencia Ficticia D4 ${label} ${tag}`])).rows[0].id as string;
    const mgr = (await q(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`d4-admin-${tag}-${n}@example.invalid`])).rows[0].id as string;
    const cg = (await q(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`d4-cna-${tag}-${n}@example.invalid`])).rows[0].id as string;
    const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [mgr, org])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) VALUES ($1,$2,$3)`, [om, org, adminRole]);
    await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active')`, [cg, org]);
    const worker = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,'CNA Ficticia') RETURNING id`, [cg])).rows[0].id as string;
    const owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [worker, org])).rows[0].id as string;
    return { org, mgr, cg, worker, owm };
  }
  async function policy(org: string, role: string | null, reqs: Array<[string, boolean, boolean]>) {
    const rs = (await q(`INSERT INTO requirement_sets (organization_id,worker_role,name) VALUES ($1,$2,'D4') RETURNING id`, [org, role])).rows[0].id;
    for (const [code, mand, review] of reqs)
      await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,$3,$4)`, [rs, await typeId(code), mand, review]);
  }
  async function credential(a: { worker: string; cg: string }, code: string, opts: { withDoc?: boolean; expires?: string; status?: string } = {}) {
    const t = await typeId(code);
    let doc: string | null = null;
    if (opts.withDoc !== false) {
      const f = (await q(`INSERT INTO stored_files (scope_type,owner_worker_id,storage_key,content_type,original_filename,size_bytes,uploaded_by_user_id,visibility,status)
        VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','licencia.pdf',100,$3,'private','active') RETURNING id`, [a.worker, `d4/${Math.random()}`, a.cg])).rows[0].id;
      doc = (await q(`INSERT INTO documents (worker_id,credential_type_id,file_id,status) VALUES ($1,$2,$3,'presented') RETURNING id`, [a.worker, t, f])).rows[0].id;
      await q(`INSERT INTO document_versions (document_id,file_id,version) VALUES ($1,$2,1)`, [doc, f]);
    }
    // created_at explícito para fijar el orden "más reciente".
    return (await q(`INSERT INTO credentials (worker_id,credential_type_id,document_id,issuing_entity_type,status,expires_at,created_at)
      VALUES ($1,$2,$3,'government',$4,$5::date, clock_timestamp()) RETURNING id`,
      [a.worker, t, doc, opts.status ?? "active", opts.expires ?? "2027-12-31"])).rows[0].id as string;
  }
  const approve = (a: { mgr: string; org: string; owm: string }, cred: string) =>
    createOrUpdateOrganizationReview(a.mgr, a.org, a.owm, cred, { reviewStatus: "approved" });
  // Igual que GET /workers/:id/compliance (la ruta convierte "sin política" en "unconfigured").
  async function summary(a: { mgr: string; org: string; owm: string }) {
    try { return await getComplianceSummary(a.mgr, a.org, a.owm); }
    catch (e) { if (e instanceof NoApplicableRequirementSetError) return { eligibility: "unconfigured", requirements: [] }; throw e; }
  }
  const out: string[] = [];
  let failed = 0;
  const expected: Record<string, [string, string]> = {
    S0a: ["not_eligible", "PROFESSIONAL_LICENSE:ORGANIZATION_REVIEW_MISSING"], S0b: ["eligible", ""],
    S1: ["unconfigured", ""], S2: ["unconfigured", ""], S3: ["not_eligible", "CPR:MISSING_CREDENTIAL"],
    S4: ["not_eligible", "PROFESSIONAL_LICENSE:ORGANIZATION_REVIEW_MISSING"], S5: ["not_eligible", "PROFESSIONAL_LICENSE:CREDENTIAL_EXPIRED"],
    S6: ["not_eligible", "PROFESSIONAL_LICENSE:CREDENTIAL_NOT_ACTIVE"], S7: ["not_eligible", "PROFESSIONAL_LICENSE:MISSING_CREDENTIAL"],
    S8: ["not_eligible", "PROFESSIONAL_LICENSE:ORGANIZATION_REVIEW_MISSING"], S9: ["not_eligible", "PROFESSIONAL_LICENSE:ORGANIZATION_REVIEW_REJECTED"],
    S10: ["eligible", ""],
  };
  const report = (id: string, desc: string, s: { eligibility: string; requirements: Array<{ requirement: string; status: string; isMandatory: boolean }> }) => {
    const causes = s.requirements.filter((r) => r.isMandatory && r.status !== "satisfied").map((r) => `${r.requirement}:${r.status}`).join(", ");
    const [eligibility, cause] = expected[id];
    const pass = s.eligibility === eligibility && causes === cause;
    if (!pass) failed++;
    out.push(`${pass ? "PASS" : "FAIL"} ${id} | ${desc} | ${s.eligibility} | [${causes || "sin motivo"}]`);
  };
  const check = (name: string, pass: boolean) => { if (!pass) failed++; out.push(`${pass ? "PASS" : "FAIL"} ${name}`); };

  // S0 control: política CNA con licencia que requiere revisión; aprobar -> apta al instante.
  { const a = await agency("S0"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true]]);
    const c = await credential(a, "PROFESSIONAL_LICENSE"); report("S0a", "control, antes de aprobar", await summary(a));
    await approve(a, c); report("S0b", "control, después de aprobar", await summary(a)); }
  // S1 agencia nueva SIN política (no hay políticas globales en la plataforma).
  { const a = await agency("S1"); const c = await credential(a, "PROFESSIONAL_LICENSE"); await approve(a, c);
    report("S1", "sin política de cumplimiento; credencial aprobada", await summary(a)); }
  // S2 política solo para HHA (ninguna para CNA ni general).
  { const a = await agency("S2"); await policy(a.org, "HHA", [["PROFESSIONAL_LICENSE", true, true]]);
    const c = await credential(a, "PROFESSIONAL_LICENSE"); await approve(a, c);
    report("S2", "política solo para HHA; credencial aprobada", await summary(a)); }
  // S3 otro requisito obligatorio pendiente.
  { const a = await agency("S3"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true], ["CPR", true, false]]);
    const c = await credential(a, "PROFESSIONAL_LICENSE"); await approve(a, c);
    report("S3", "licencia aprobada, falta CPR obligatoria", await summary(a)); }
  // S4 dos credenciales del mismo tipo: se aprobó la antigua, existe otra más reciente.
  { const a = await agency("S4"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true]]);
    const old = await credential(a, "PROFESSIONAL_LICENSE"); await approve(a, old);
    await credential(a, "PROFESSIONAL_LICENSE", { withDoc: false });
    report("S4", "aprobada la antigua; hay otra licencia más nueva sin revisar", await summary(a)); }
  // S5 aprobada pero vencida por fecha.
  { const a = await agency("S5"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true]]);
    const c = await credential(a, "PROFESSIONAL_LICENSE", { expires: "2026-10-01" }); await approve(a, c);
    report("S5", "aprobada con fecha de vencimiento pasada", await summary(a)); }
  // S6 aprobada pero la credencial quedó con estado "expired" en el formulario.
  { const a = await agency("S6"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true]]);
    const c = await credential(a, "PROFESSIONAL_LICENSE", { status: "expired" }); await approve(a, c);
    report("S6", "aprobada con estado de credencial 'expired'", await summary(a)); }
  // S7 se aprobó un tipo distinto del exigido.
  { const a = await agency("S7"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true]]);
    const c = await credential(a, "LEY_300"); await approve(a, c);
    report("S7", "se aprobó LEY_300 pero la política exige PROFESSIONAL_LICENSE", await summary(a)); }
  // S8 aprobada y luego la cuidadora sube una versión nueva (vuelve a pendiente).
  { const a = await agency("S8"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true]]);
    const c = await credential(a, "PROFESSIONAL_LICENSE"); await approve(a, c);
    await q(`UPDATE organization_credential_reviews SET review_status='pending', notes=NULL, reviewed_at=NULL WHERE credential_id=$1`, [c]); // efecto de app_reset_credential_review_pending
    report("S8", "aprobada y luego reemplazada por la cuidadora", await summary(a)); }

  // S9 rechazada por la agencia: sigue bloqueada y el motivo dice "rechazada", no "pendiente".
  { const a = await agency("S9"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true]]);
    const c = await credential(a, "PROFESSIONAL_LICENSE");
    await createOrUpdateOrganizationReview(a.mgr, a.org, a.owm, c, { reviewStatus: "rejected", notes: "Ilegible" });
    report("S9", "documento rechazado por la agencia", await summary(a)); }
  // S10 requisito opcional ausente: no bloquea (solo cuentan los obligatorios configurados).
  { const a = await agency("S10"); await policy(a.org, "CNA", [["PROFESSIONAL_LICENSE", true, true], ["CPR", false, false]]);
    const c = await credential(a, "PROFESSIONAL_LICENSE"); await approve(a, c);
    report("S10", "obligatoria aprobada; opcional ausente", await summary(a)); }
  // Sin política: la misma evaluación que usan asignar turno y SmartMatch falla (bloqueo intacto).
  { const a = await agency("S11"); const c = await credential(a, "PROFESSIONAL_LICENSE"); await approve(a, c);
    let blocked = false;
    try { await evaluateWorkerEligibility(a.mgr, a.org, a.owm); } catch (e) { blocked = e instanceof NoApplicableRequirementSetError; }
    check("S11 sin política: la evaluación que usan las asignaciones lanza NO_APPLICABLE_REQUIREMENT_SET", blocked);
    const platformSets = Number((await q(`SELECT count(*)::int n FROM requirement_sets WHERE organization_id IS NULL`)).rows[0].n);
    check("S12 ETNARA no trae políticas universales (0 globales)", platformSets === 0); }

  console.log(out.join("\n"));
  console.log(failed === 0 ? `OK: ${out.length}/${out.length}` : `FALLÓ: ${failed}`);
  await closeDb(); await admin.end();
  if (failed) process.exit(1);
}
main().catch(async (e) => { console.error(e); process.exit(1); });
