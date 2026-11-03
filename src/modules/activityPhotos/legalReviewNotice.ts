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

/** 42883: the function is not in this database yet (code deployed before its migration). */
const isMissingFunction = (e: unknown) => (e as { code?: string })?.code === "42883";
const warned = new Set<string>();
function warnOnce(code: string) {
  if (warned.has(code)) return;
  warned.add(code);
  console.error(code, { reason: "migration not applied yet" });
}

export async function runLegalReviewNotice(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app_photo_legal_review_notify() AS n`.execute(db);
  const created = Number(r.rows[0]?.n ?? 0);
  if (created > 0) console.log(`PHOTO_LEGAL_HOLD_NOTICE ${JSON.stringify({ created })}`);
  return created;
}

/**
 * 145 (§4): agencies without an active administrator. One notice per episode,
 * after 24 h, to the agency's active supervisors and to ETNARA central. The
 * database decides; logs carry the number created only.
 */
export async function runAdminGapNotice(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app_org_admin_gap_notify() AS n`.execute(db);
  const created = Number(r.rows[0]?.n ?? 0);
  if (created > 0) console.log(`AGENCY_ADMIN_GAP_NOTICE ${JSON.stringify({ created })}`);
  return created;
}

export function startLegalReviewNoticeWorker(): () => void {
  const legalOn = env.PHOTO_LEGAL_HOLD_NOTICE !== "off";
  const gapOn = env.AGENCY_ADMIN_GAP_NOTICE !== "off";
  if (!legalOn && !gapOn) return () => undefined;
  const run = async (name: string, fn: () => Promise<number>) => {
    try { await fn(); }
    catch (error) {
      if (isMissingFunction(error)) { warnOnce(`${name}_UNAVAILABLE`); return; }
      const failure = error as { name?: string; code?: string };
      console.error(`${name} failed`, { name: failure.name ?? "Error", code: failure.code ?? "UNKNOWN" });
    }
  };
  const tick = async () => {
    if (legalOn) await run("PHOTO_LEGAL_HOLD_NOTICE", runLegalReviewNotice);
    if (gapOn) await run("AGENCY_ADMIN_GAP_NOTICE", runAdminGapNotice);
  };
  void tick();
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
