import { describe, expect, it } from "vitest";
import type { Client } from "pg";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPendingMigrations } from "../scripts/lib/runMigrations.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "migrations");

class FakeClient {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  failMigration = false;
  historyExists = true;
  hasSchema = false;
  hasLastLegacyMigration = false;
  applied = new Set<string>();

  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (text.includes("to_regclass('public.schema_migrations')")) {
      return { rows: [{ exists: this.historyExists }] };
    }
    if (text.includes("AS has_last_legacy_migration")) {
      return { rows: [{ has_schema: this.hasSchema, has_last_legacy_migration: this.hasLastLegacyMigration }] };
    }
    if (text === "SELECT filename FROM schema_migrations") {
      return { rows: [...this.applied].map((filename) => ({ filename })) };
    }
    if (this.failMigration && text.includes("SELECT 1;")) throw new Error("forced failure");
    if (text.startsWith("INSERT INTO schema_migrations") && typeof values?.[0] === "string") {
      this.applied.add(values[0]);
    }
    return { rows: [] };
  }
}

describe("applyPendingMigrations", () => {
  it("applies and records a migration in one explicit transaction", async () => {
    const client = new FakeClient();
    await applyPendingMigrations(client as unknown as Client, fixtures);

    const statements = client.calls.map((call) => call.text);
    const begin = statements.indexOf("BEGIN");
    const migration = statements.indexOf("SELECT 1;\n");
    const record = statements.indexOf("INSERT INTO schema_migrations (filename) VALUES ($1)");
    const commit = statements.indexOf("COMMIT");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(migration);
    expect(migration).toBeLessThan(record);
    expect(record).toBeLessThan(commit);
    expect(client.calls[record]?.values).toEqual(["001_ok.sql"]);
  });

  it("rolls back and never records a migration that fails", async () => {
    const client = new FakeClient();
    client.failMigration = true;

    await expect(applyPendingMigrations(client as unknown as Client, fixtures)).rejects.toThrow(
      "Migracion 001_ok.sql fallo y fue revertida"
    );
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
    expect(client.calls.some((call) => call.text === "INSERT INTO schema_migrations (filename) VALUES ($1)")).toBe(false);
    expect(client.calls.at(-1)?.text).toContain("pg_advisory_unlock");
  });

  it("baselines 001..033 only when the legacy completion witness exists", async () => {
    const client = new FakeClient();
    client.historyExists = false;
    client.hasSchema = true;
    client.hasLastLegacyMigration = true;

    await applyPendingMigrations(client as unknown as Client, fixtures);
    expect(client.applied).toEqual(new Set(["001_ok.sql"]));
    expect(client.calls.some((call) => call.text === "SELECT 1;\n")).toBe(false);
  });

  it("stops an ambiguous legacy database without applying or recording files", async () => {
    const client = new FakeClient();
    client.historyExists = false;
    client.hasSchema = true;

    await expect(applyPendingMigrations(client as unknown as Client, fixtures)).rejects.toThrow(
      "requiere reconciliacion manual"
    );
    expect(client.applied.size).toBe(0);
    expect(client.calls.some((call) => call.text === "SELECT 1;\n")).toBe(false);
    expect(client.calls.at(-1)?.text).toContain("pg_advisory_unlock");
  });
});
