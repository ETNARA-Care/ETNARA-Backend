import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const MIG = read("migrations/151_caregiver_initiated_agency_messages.sql");
const code = MIG.replace(/--.*$/gm, "");
const RB = read("ops/151_caregiver_initiated_agency_messages.rollback.sql");
const M136 = read("migrations/136_caregiver_agency_direct_messages.sql");
const fn = (src: string, name: string) => { const i = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); return src.slice(i, src.indexOf("$$;", i) + 3); };

describe("151 — «Escribir a mi agencia» and authorized supervisors", () => {
  it("keeps the 136 signatures, adds the caregiver opener and touches no existing message, thread or participant", () => {
    expect(code).toContain("CREATE OR REPLACE FUNCTION public.app_user_can_access_caregiver_thread(p_user uuid, p_thread uuid)");
    expect(code).toContain("CREATE OR REPLACE FUNCTION public.app_open_caregiver_thread(p_worker_membership uuid)");
    expect(code).toContain("CREATE OR REPLACE FUNCTION public.app_open_my_agency_thread()");
    expect(code).not.toMatch(/UPDATE\s+(public\.)?(messages|message_threads|message_thread_participants)\b|DELETE\s+FROM\s+(public\.)?(messages|message_threads|message_thread_participants)\b/);
    expect(code).not.toMatch(/establishment_documents|credentials|149_/);
  });
  it("the application only READS the authorizations; writes go through audited functions", () => {
    expect(code).toContain("GRANT SELECT ON caregiver_message_handlers TO app_runtime;");
    expect(code).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*caregiver_message_handlers/);
    expect(code).toMatch(/CREATE POLICY platform_phi_deny ON caregiver_message_handlers AS RESTRICTIVE/);
    expect(code).toContain("'CAREGIVER_MESSAGE_HANDLER_GRANTED'");
    expect(code).toContain("'CAREGIVER_MESSAGE_HANDLER_REVOKED'");
    expect(code).toContain("'initiated_by', 'caregiver'");
    // All active administrators; supervisors only with a current authorization.
    expect(code).toMatch(/r\.code = 'ORGANIZATION_ADMIN'\s+OR \(r\.code = 'SUPERVISOR' AND EXISTS/);
  });
  it("losing the role or the membership revokes the authorization (no silent restore)", () => {
    expect(code).toMatch(/AFTER DELETE ON user_roles FOR EACH ROW EXECUTE FUNCTION public\.app_revoke_caregiver_message_handler_on_loss\(\)/);
    expect(code).toMatch(/AFTER UPDATE OF status ON organization_memberships FOR EACH ROW EXECUTE FUNCTION public\.app_revoke_caregiver_message_handler_on_loss\(\)/);
  });
  it("the rollback restores both 136 functions literally and keeps conversations and messages", () => {
    expect(RB).toContain(fn(M136, "app_user_can_access_caregiver_thread"));
    expect(RB).toContain(fn(M136, "app_open_caregiver_thread"));
    expect(RB).not.toMatch(/DELETE FROM (messages|message_threads|message_thread_participants)/);
    expect(RB).toContain("DELETE FROM schema_migrations WHERE filename = '151_caregiver_initiated_agency_messages.sql';");
  });
  it("routes: caregiver opener and administrator-only authorization", () => {
    expect(read("src/modules/messaging/messaging.routes.ts")).toContain('"/organizations/:organizationId/my-agency-conversation"');
    const team = read("src/modules/team/team.service.ts");
    expect(team).toMatch(/export async function setCaregiverMessageHandler[\s\S]*await assertOrgAdmin\(trx\);[\s\S]*app_set_caregiver_message_handler/);
  });
});
