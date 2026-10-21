import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const m076 = read("migrations/076_revoke_stale_shift_access.sql");
const m081 = read("migrations/081_fix_shift_assignment_rls_recursion.sql");

const body = (sql: string) => {
  const start = sql.indexOf("SELECT EXISTS (");
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end).replace(/public\./g, "").replace(/\s+/g, " ").trim();
};

describe("081 shift-assignment RLS recursion fix", () => {
  it("keeps the 076 authorization logic verbatim", () => {
    expect(body(m081)).toBe(body(m076));
  });

  it("runs as a narrow SECURITY DEFINER helper with a fixed search_path", () => {
    expect(m081).toContain("SECURITY DEFINER");
    expect(m081).toContain("SET search_path = pg_catalog, public");
    expect(m081).toContain("NULLIF(current_setting('app.current_org_id', true), '')::uuid");
    expect(m081).toContain("REVOKE ALL ON FUNCTION public.app_worker_has_shift_assignment(uuid) FROM PUBLIC");
    expect(m081).toContain("GRANT EXECUTE ON FUNCTION public.app_worker_has_shift_assignment(uuid) TO app_runtime");
    expect(m081).not.toMatch(/BYPASSRLS|DISABLE ROW LEVEL SECURITY|DROP POLICY/i);
  });
});
