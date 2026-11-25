/** 161 · Estados por fechas de los documentos autodeclarados (puro, sin base de datos). */
export const EXPIRING_SOON_DAYS = 30;
export type PracticeDocumentStatus = "REGISTERED" | "EXPIRING_SOON" | "EXPIRED" | "MISSING" | "RETIRED";

/** Estado por fechas. `today` en AAAA-MM-DD (hora de Puerto Rico no altera fechas de calendario). */
export function practiceDocumentStatus(doc: { status: string; expires_at: string | null } | null, today: string): PracticeDocumentStatus {
  if (!doc) return "MISSING";
  if (doc.status === "revoked") return "RETIRED";
  if (doc.expires_at && doc.expires_at < today) return "EXPIRED";
  if (doc.expires_at) {
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + EXPIRING_SOON_DAYS);
    if (doc.expires_at <= soon.toISOString().slice(0, 10)) return "EXPIRING_SOON";
  }
  return "REGISTERED";
}
