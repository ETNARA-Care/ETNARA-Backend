import type { TowerHealthObservation } from "./observability.js";

/** Minimal sanitized Cloudflare DNS response; no DNS record content or zone credentials. */
export interface CloudflareDnsCheck {
  success: boolean;
  zoneStatus?: string | null;
  recordsVerified?: boolean | null;
}
export function cloudflareDnsObservation(
  check: CloudflareDnsCheck | null,
  checkedAt: string,
): TowerHealthObservation {
  const health = !check || !check.success ? "unknown"
    : check.zoneStatus === "active" && check.recordsVerified === true ? "healthy"
    : check.zoneStatus === "active" && check.recordsVerified === false ? "degraded"
    : check.zoneStatus === "pending" ? "degraded" : "unknown";
  return {
    service: "dns", environment: "production", checkedAt,
    health, source: "cloudflare-dns",
    summary: health === "healthy" ? "Zone active and expected DNS records verified"
      : health === "degraded" ? "DNS configuration needs attention"
      : "DNS status not verified",
  };
}
/** API success alone never proves DNS availability; expected records must be checked. */
export function cloudflareZoneStatusFromApi(value: unknown): CloudflareDnsCheck | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.success !== true || !v.result || typeof v.result !== "object") return null;
  const zone = v.result as Record<string, unknown>;
  return { success: true, zoneStatus: typeof zone.status === "string" ? zone.status : null, recordsVerified: null };
}
