import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const mig = read("migrations/159_worker_profile_link_on_accept.sql");
const rollback = read("ops/159_worker_profile_link_on_accept.rollback.sql");
const service = read("src/modules/accessInvitations/accessInvitations.service.ts");
const m046 = read("migrations/046_access_invitation_activation_ambiguity_fix.sql");

describe("159: una persona, un perfil de cuidador al aceptar invitaciones", () => {
  it("reutiliza el perfil propio solo dentro de la activación, con bloqueo y auditoría", () => {
    expect(mig).toMatch(/WHERE own\.user_id = v_user_id\s+FOR UPDATE;/);
    expect(mig).toMatch(/SET worker_id = v_own_worker_id, updated_at = now\(\)\s+WHERE target_membership\.id = v_inv\.worker_membership_id;/);
    expect(mig).toMatch(/'WORKER_PROFILE_LINKED_ON_ACCEPT'/);
  });
  it("nunca duplica ni mueve datos de una ficha que no esté vacía", () => {
    expect(mig).toMatch(/MESSAGE = 'WORKER_ALREADY_IN_ORGANIZATION'/);
    for (const t of ["public.credentials", "public.documents", "public.stored_files"]) expect(mig).toContain(t);
    expect(mig).toMatch(/MESSAGE = 'WORKER_PROFILE_CONFLICT'/);
    expect(mig).not.toMatch(/DELETE FROM/);
  });
  it("conserva la identidad, la familia y el comportamiento de 046 sin perfil propio", () => {
    expect(mig).toMatch(/MESSAGE = 'INVITATION_IDENTITY_MISMATCH'/);
    expect(mig).toMatch(/family_relationships_user_id_care_recipient_id_key/);
    expect(mig).toMatch(/IF v_own_worker_id IS NULL OR v_own_worker_id = v_worker_id THEN/);
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION app_activate_access_invitation\(text, text, uuid\) TO app_runtime;/);
  });
  it("el backend traduce los códigos nuevos y nunca responde 500 por workers_user_id_key", () => {
    expect(service).toMatch(/"WORKER_ALREADY_IN_ORGANIZATION",\s+"WORKER_PROFILE_CONFLICT",/);
    expect(service).toMatch(/message\.includes\("workers_user_id_key"\)\) throw new AccessInvitationError\("WORKER_PROFILE_CONFLICT"\)/);
  });
  it("la reversión restaura exactamente la definición de 046", () => {
    const fn = m046.slice(m046.indexOf("CREATE OR REPLACE FUNCTION")).trim();
    expect(rollback).toContain(fn);
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '159_worker_profile_link_on_accept\.sql';/);
  });
});
