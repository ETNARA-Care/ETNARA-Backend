/**
 * SYNTHETIC SmartMatch staging seed. Runs ONLY inside the isolated Railway
 * project "etnara-smartmatch-staging" (or a local disposable database), and
 * only when SMARTMATCH_STAGING_SEED=true. Idempotent: existing synthetic users
 * and agencies are reused; nothing is ever deleted or overwritten except the
 * synthetic users' password hash (so the staging password can be rotated).
 *
 * Creates two independent synthetic agencies with administrators, a
 * supervisor and caregivers (WORKER + active worker membership, an active BLS
 * credential and weekly availability). All e-mails use the reserved
 * ".invalid" TLD. No real patient or caregiver data.
 *
 * Requires: MIGRATIONS_DATABASE_URL (administrative connection),
 *           SMARTMATCH_STAGING_DEMO_PASSWORD (>= 16 characters).
 */
import pg from "pg";
import { hashPassword } from "../src/security/password.js";

const ALLOWED_PROJECT = "etnara-smartmatch-staging";

export const STAGING_AGENCIES = [
  {
    key: "a", name: "Agencia Sintética A (staging)",
    people: [
      { email: "admin1@agencia-a.invalid", roles: ["ORGANIZATION_ADMIN"], name: "Admin Uno A" },
      { email: "admin2@agencia-a.invalid", roles: ["ORGANIZATION_ADMIN"], name: "Admin Dos A" },
      { email: "supervisor@agencia-a.invalid", roles: ["SUPERVISOR"], name: "Supervisora A" },
      { email: "cuidadora1@agencia-a.invalid", roles: ["WORKER"], name: "Cuidadora Uno A", worker: true },
      { email: "cuidadora2@agencia-a.invalid", roles: ["WORKER"], name: "Cuidadora Dos A", worker: true },
      // Gate 6: synthetic relative of the synthetic person (address permission off by default).
      { email: "familia@agencia-a.invalid", roles: ["FAMILY"], name: "Familiar A", family: true },
    ],
  },
  {
    key: "b", name: "Agencia Sintética B (staging)",
    people: [
      { email: "admin@agencia-b.invalid", roles: ["ORGANIZATION_ADMIN"], name: "Admin B" },
      { email: "cuidadora@agencia-b.invalid", roles: ["WORKER"], name: "Cuidadora B", worker: true },
    ],
  },
] as const;

function assertAllowed(): { adminUrl: string; password: string } {
  if (process.env.SMARTMATCH_STAGING_SEED !== "true") {
    console.log("SmartMatch staging seed skipped (SMARTMATCH_STAGING_SEED is not 'true').");
    process.exit(0);
  }
  const project = process.env.RAILWAY_PROJECT_NAME;
  const local = process.env.ETNARA_DISPOSABLE_DB === "true" && !project;
  if (project !== ALLOWED_PROJECT && !local) {
    throw new Error(`Refusing to seed: RAILWAY_PROJECT_NAME is "${project ?? ""}", expected "${ALLOWED_PROJECT}"`);
  }
  const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
  const password = process.env.SMARTMATCH_STAGING_DEMO_PASSWORD;
  if (!adminUrl) throw new Error("MIGRATIONS_DATABASE_URL is required");
  if (!password || password.length < 16) throw new Error("SMARTMATCH_STAGING_DEMO_PASSWORD (>= 16 chars) is required");
  return { adminUrl, password };
}

async function main() {
  const { adminUrl, password } = assertAllowed();
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => client.query<T>(s, p);
  const hash = await hashPassword(password);
  try {
    await q("BEGIN");
    const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code = 'BLS'`)).rows[0]?.id;
    if (!bls) throw new Error("credential type BLS not found (migrations not applied?)");

    for (const agency of STAGING_AGENCIES) {
      let orgId = (await q<{ id: string }>(`SELECT id FROM organizations WHERE name = $1`, [agency.name])).rows[0]?.id;
      if (!orgId) {
        orgId = (await q<{ id: string }>(
          `INSERT INTO organizations (name, organization_type, status) VALUES ($1, 'HOME_CARE_AGENCY', 'active') RETURNING id`,
          [agency.name])).rows[0].id;
        const rs = (await q<{ id: string }>(
          `INSERT INTO requirement_sets (organization_id, name) VALUES ($1, 'SmartMatch staging BLS') RETURNING id`, [orgId])).rows[0].id;
        await q(`INSERT INTO requirements (requirement_set_id, credential_type_id, is_mandatory, requires_organization_review)
                 VALUES ($1, $2, true, false)`, [rs, bls]);
      }
      // Pilot (migration 108): only Agency A gets SmartMatch and «En camino» by default.
      // ON CONFLICT DO NOTHING keeps whatever ETNARA central switched later.
      if (agency.key === "a") {
        await q(`INSERT INTO organization_features (organization_id, feature_code, enabled)
                 SELECT $1, c, true FROM unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c
                 ON CONFLICT (organization_id, feature_code) DO NOTHING`, [orgId]);
      }
      // One synthetic person receiving care per agency, for "Crear turno" (Gate 5).
      const recipientLast = `Sintética ${agency.key.toUpperCase()} (staging)`;
      await q(`INSERT INTO care_recipients (organization_id, first_name, last_name)
               SELECT $1, 'Persona', $2::text
               WHERE NOT EXISTS (SELECT 1 FROM care_recipients WHERE organization_id = $1 AND last_name = $2::text)`,
        [orgId, recipientLast]);
      const recipientId = (await q<{ id: string }>(`SELECT id FROM care_recipients WHERE organization_id = $1 AND last_name = $2`,
        [orgId, recipientLast])).rows[0].id;
      // Gate 6: a synthetic primary service address (fictional street, town-center coordinates).
      await q(`INSERT INTO care_recipient_locations (care_recipient_id, organization_id, label, address_line, municipality,
                 postal_code, access_notes, latitude, longitude, is_primary)
               SELECT $1, $2, 'Principal', 'Calle Sintética 100 (staging)', $3, $4, 'Dato sintético de prueba.', $5, $6, true
               WHERE NOT EXISTS (SELECT 1 FROM care_recipient_locations WHERE care_recipient_id = $1)`,
        agency.key === "a" ? [recipientId, orgId, "Caguas", "00725", 18.2341, -66.0485] : [recipientId, orgId, "Cayey", "00736", 18.1119, -66.1660]);
      for (const person of agency.people) {
        let userId = (await q<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [person.email])).rows[0]?.id;
        if (userId) {
          await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hash]);
          continue;
        }
        userId = (await q<{ id: string }>(
          `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`, [person.email, hash])).rows[0].id;
        const m = (await q<{ id: string }>(
          `INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1, $2, 'active') RETURNING id`,
          [userId, orgId])).rows[0].id;
        await q(`INSERT INTO user_roles (organization_membership_id, organization_id, role_id)
                 SELECT $1, $2, id FROM roles WHERE code = ANY($3)`, [m, orgId, [...person.roles]]);
        if ("family" in person && person.family) {
          await q(`INSERT INTO family_relationships (user_id, organization_id, care_recipient_id, relationship_type, status)
                   VALUES ($1, $2, $3, 'familiar', 'active') ON CONFLICT DO NOTHING`, [userId, orgId, recipientId]);
        }
        if ("worker" in person && person.worker) {
          const w = (await q<{ id: string }>(`INSERT INTO workers (user_id, display_name) VALUES ($1, $2) RETURNING id`, [userId, person.name])).rows[0].id;
          const owm = (await q<{ id: string }>(
            `INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role)
             VALUES ($1, $2, 'active', 'caregiver') RETURNING id`, [w, orgId])).rows[0].id;
          await q(`INSERT INTO credentials (worker_id, credential_type_id, issuing_entity_type, status, expires_at)
                   VALUES ($1, $2, 'external_provider', 'active', current_date + 365)`, [w, bls]);
          await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id, organization_id, timezone)
                   VALUES ($1, $2, 'America/Puerto_Rico')`, [owm, orgId]);
          for (let d = 0; d < 7; d++) {
            await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id, organization_id, weekday, start_time, end_time)
                     VALUES ($1, $2, $3, '06:00', '22:00')`, [owm, orgId, d]);
          }
        }
      }
    }
    await q("COMMIT");
    console.log(`SmartMatch staging seed ready: ${STAGING_AGENCIES.length} synthetic agencies, ${STAGING_AGENCIES.reduce((n, a) => n + a.people.length, 0)} synthetic users.`);
  } catch (err) {
    await q("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error("SmartMatch staging seed failed:", (err as Error).message); process.exit(1); });
