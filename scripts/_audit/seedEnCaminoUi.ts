/** Local UI seed for the En Camino browser check (disposable DB only; not committed). */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
const url = process.env.MIGRATIONS_DATABASE_URL!;
if (process.env.ETNARA_DISPOSABLE_DB !== "true" || /railway|rlwy/.test(url)) throw new Error("disposable only");
(async () => {
  const { hashPassword } = await import("../../src/security/password.js");
  const db = new pg.Client({ connectionString: url }); await db.connect();
  const q = (s: string, p: unknown[] = []) => db.query(s, p);
  const tag = randomUUID().slice(0, 6); const pw = randomBytes(9).toString("hex"); const hash = await hashPassword(pw);
  const org = (await q(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id,c,true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [`Agencia UI ${tag}`])).rows[0].id;
  const bls = (await q(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const rs = (await q(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'UI') RETURNING id`, [org])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  const user = async (key: string, roles: string[], worker = false) => {
    const email = `ui-${key}-${tag}@example.invalid`;
    const id = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [id, org])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, org, roles]);
    let mid: string | null = null;
    if (worker) {
      const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Cuidadora UI') RETURNING id`, [id])).rows[0].id;
      mid = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, org])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [w, bls]);
    }
    return { email, id, mid };
  };
  const admin = await user("admin", ["ORGANIZATION_ADMIN"]); const cg = await user("cg", ["WORKER"], true); const cg2 = await user("cg2", ["WORKER"], true);
  const rec = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Persona','Sintetica') RETURNING id`, [org])).rows[0].id;
  const shifts: string[] = [];
  for (const startMin of [40, 200, 360]) {
    const s = (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,required_role,status) VALUES ($1,$2, date_trunc('minute', now()) + make_interval(mins => $3), date_trunc('minute', now()) + make_interval(mins => $3 + 90),'Cuidador/a','confirmed') RETURNING id`, [org, rec, startMin])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,role_in_shift,response_status,responded_at) VALUES ($1,$2,$3,$4,'Cuidador/a','accepted',now())`, [org, s, cg.mid, rec]);
    shifts.push(s);
  }
  // the 2nd and 3rd visits start in 200/360 min: move them into the «Voy en camino» window after seeding (journey opens 2 h before)
  await q(`UPDATE shifts SET scheduled_start = date_trunc('minute', now()) + interval '50 minutes', scheduled_end = date_trunc('minute', now()) + interval '140 minutes' WHERE id = ANY($1)`, [[shifts[1], shifts[2]]]);
  writeFileSync(process.argv[2], JSON.stringify({ pw, org, admin: admin.email, cg: cg.email, cg2mid: cg2.mid, shifts }));
  await db.end();
})();
