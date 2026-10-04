import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const provisioning = readFileSync(
  new URL("../scripts/decouplePlatformAdmin.ts", import.meta.url),
  "utf8",
);

describe("platform admin password preservation", () => {
  it("uses the Railway bootstrap password only when the account has no password yet", () => {
    expect(provisioning).toContain(
      "password_hash=COALESCE(users.password_hash, EXCLUDED.password_hash)",
    );
    expect(provisioning).not.toContain(
      "password_hash=EXCLUDED.password_hash, updated_at=now()",
    );
  });
});
