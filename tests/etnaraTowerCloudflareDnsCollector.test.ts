import { describe, expect, it } from "vitest";
import { cloudflareDnsObservation, cloudflareZoneStatusFromApi } from "../src/modules/etnaraTower/cloudflareDnsCollector.js";
const at = "2026-10-16T18:00:00Z";
describe("Tower Cloudflare DNS adapter", () => {
  it("does not mark active zone healthy without record verification", () => {
    const result = cloudflareZoneStatusFromApi({ success: true, result: { status: "active", id: "secret-zone" } });
    expect(cloudflareDnsObservation(result, at).health).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("secret-zone");
  });
  it("reports healthy only after records are verified", () => {
    expect(cloudflareDnsObservation({ success: true, zoneStatus: "active", recordsVerified: true }, at).health).toBe("healthy");
  });
  it("warns on missing expected DNS records", () => {
    expect(cloudflareDnsObservation({ success: true, zoneStatus: "active", recordsVerified: false }, at).health).toBe("degraded");
  });
  it("defaults to unknown on missing or unsuccessful API response", () => {
    expect(cloudflareDnsObservation(null, at).health).toBe("unknown");
    expect(cloudflareZoneStatusFromApi({ success: false, result: { status: "active" } })).toBeNull();
  });
});
