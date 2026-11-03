import { sql } from "kysely";
import { db } from "../../config/db.js";
import { env } from "../../config/env.js";

/**
 * Activity photos v2 — D2 (migration 144): daily in-app notice of overdue
 * legal-hold reviews.
 *
 * Independent of the expiry / purge job (PHOTO_RETENTION_JOB): it runs with that
 * job off. The database function decides everything and refuses any request
 * context or ETNARA central:
 *  - one notice per active ORGANIZATION_ADMIN, per agency, per Puerto Rico day
 *    (unique index: a restart, a second replica or an hourly tick never duplicate it);
 *  - each agency's count comes only from its own photos and goes only to its own
 *    administrators;
 *  - the notice carries the count and a link only: never a photo, a resident,
 *    clinical data, the legal basis or the reference. In-app only (no e-mail, no SMS).
 * Logs carry the number of notices created only.
 */
const CHECK_INTERVAL_MS = 60 * 60_000; // hourly; the database keeps it to once a day

export async function runLegalReviewNotice(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app_photo_legal_review_notify() AS n`.execute(db);
  const created = Number(r.rows[0]?.n ?? 0);
  if (created > 0) console.log(`PHOTO_LEGAL_HOLD_NOTICE ${JSON.stringify({ created })}`);
  return created;
}

export function startLegalReviewNoticeWorker(): () => void {
  if (env.PHOTO_LEGAL_HOLD_NOTICE === "off") return () => undefined;
  const tick = async () => {
    try { await runLegalReviewNotice(); }
    catch (error) {
      const failure = error as { name?: string; code?: string };
      console.error("Legal hold notice failed", { name: failure.name ?? "Error", code: failure.code ?? "UNKNOWN" });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
