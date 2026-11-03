import { pool } from "../../config/db.js";
import { env } from "../../config/env.js";
import { deletePhotoObject, isPhotoStorageConfigured, listPhotoObjects, photoObjectExists } from "./photoStorage.js";

/**
 * Activity photos v2 — V2 (migration 142): the periodic expiry / purge job.
 *
 * Runs inside the backend as app_runtime WITHOUT a tenant context (the 142
 * functions refuse any call that carries one). Off unless PHOTO_RETENTION_JOB
 * says otherwise:
 *  - simulate: counts only (expired, held, lapsed holds, pending removals,
 *    orphans / missing files on the weekly reconciliation). Writes nothing but
 *    the run log. Never deletes.
 *  - on: records lapsed holds; marks EXPIRED photos for deletion only if the
 *    retention policy is APPROVED with purge enabled (the database refuses it
 *    otherwise: the 30 provisional days never delete); retries removals a person
 *    already decided; reconciles weekly.
 * Every deletion is verified (HeadObject 404) before the database forgets the
 * key. Logs and the run log carry counts and error class names only.
 */
export type RetentionJobMode = "simulate" | "on";

export interface RetentionRunResult {
  mode: RetentionJobMode;
  skipped?: "LOCKED" | "STORAGE_NOT_CONFIGURED";
  policy: { status: string; days: number; purgeEnabled: boolean } | null;
  expiredDue: number; expiredMarked: number; heldSkipped: number; holdsLapsed: number;
  queuePending: number; purgedVerified: number; purgeFailed: number; pendingOver24h: number;
  reconciled: boolean; orphansFound: number; orphansDeleted: number; missingMarked: number;
  /** 143: photos under a legal hold (never deleted), overdue reviews (alert, never released) and held photos whose file is gone. */
  legalHeld: number; legalReviewOverdue: number; legalHeldMissing: number;
  errorCodes: string[];
}

const LOCK_KEY = 141_142; // one cycle at a time across replicas
const RECONCILE_EVERY_MS = 7 * 86_400_000;
const ORPHAN_MIN_AGE_MS = 60 * 60_000; // never touch an upload that may still be in flight

type Q = { query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> };
const errName = (err: unknown) => {
  const name = (err as { name?: string; code?: string })?.code ?? (err as Error)?.name ?? "Error";
  return /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : "Error";
};

/** Only for the local verifier (ages cannot be faked in a test bucket). The worker never passes it. */
export interface RetentionTestOverrides { orphanMinAgeMs?: number; orphanDeleteMinAgeMs?: number }

export async function runRetentionCycle(opts: { mode: RetentionJobMode; reconcile?: boolean | "auto"; testOverrides?: RetentionTestOverrides }): Promise<RetentionRunResult> {
  if (opts.testOverrides && env.NODE_ENV === "production") throw new Error("RETENTION_TEST_OVERRIDES_REFUSED");
  const started = new Date();
  const out: RetentionRunResult = {
    mode: opts.mode, policy: null, expiredDue: 0, expiredMarked: 0, heldSkipped: 0, holdsLapsed: 0, queuePending: 0,
    purgedVerified: 0, purgeFailed: 0, pendingOver24h: 0, reconciled: false, orphansFound: 0, orphansDeleted: 0, missingMarked: 0,
    legalHeld: 0, legalReviewOverdue: 0, legalHeldMissing: 0, errorCodes: [],
  };
  const client = await pool.connect();
  const db = client as unknown as Q;
  const errors = new Set<string>();
  try {
    const lock = await db.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY]);
    if (!lock.rows[0]?.ok) { out.skipped = "LOCKED"; return out; }
    try {
      const pol = (await db.query<{ status: string; retention_days: number; purge_enabled: boolean }>(`SELECT * FROM app_photo_retention_policy_state()`)).rows[0];
      out.policy = pol ? { status: pol.status, days: pol.retention_days, purgeEnabled: pol.purge_enabled } : null;
      const before = (await db.query<{ expired_due: number; held: number; holds_lapsed: number; queue_pending: number; pending_over_24h: number;
        legal_held: number; legal_review_overdue: number }>(`SELECT * FROM app_photo_retention_counts()`)).rows[0];
      out.expiredDue = before.expired_due; out.heldSkipped = before.held; out.queuePending = before.queue_pending;
      out.legalHeld = before.legal_held; out.legalReviewOverdue = before.legal_review_overdue;

      if (opts.mode === "simulate") {
        out.holdsLapsed = before.holds_lapsed; out.pendingOver24h = before.pending_over_24h;
      } else {
        out.holdsLapsed = (await db.query<{ n: number }>(`SELECT app_photo_record_lapsed_holds(500) AS n`)).rows[0].n;
        if (out.policy?.status === "APPROVED" && out.policy.purgeEnabled) {
          out.expiredMarked = (await db.query<{ n: number }>(`SELECT app_photo_mark_expired(500) AS n`)).rows[0].n;
        }
        if (isPhotoStorageConfigured()) {
          for (let round = 0; round < 10; round++) {
            const batch = (await db.query<{ photo_id: string; storage_key: string }>(`SELECT photo_id, storage_key FROM app_photo_purge_next(50)`)).rows;
            if (batch.length === 0) break;
            for (const item of batch) {
              let verified = false; let code: string | null = null;
              try {
                await deletePhotoObject(item.storage_key);
                verified = !(await photoObjectExists(item.storage_key));
                if (!verified) code = "STILL_PRESENT";
              } catch (err) { code = errName(err); errors.add(code); }
              await db.query(`SELECT app_photo_purge_result($1::uuid, $2, $3)`, [item.photo_id, verified, code]);
              if (verified) out.purgedVerified++; else out.purgeFailed++;
            }
          }
        } else {
          errors.add("PHOTO_STORAGE_NOT_CONFIGURED");
        }
        const after = (await db.query<{ pending_over_24h: number; queue_pending: number }>(`SELECT * FROM app_photo_retention_counts()`)).rows[0];
        out.pendingOver24h = after.pending_over_24h; out.queuePending = after.queue_pending;
      }

      // Weekly reconciliation (or when asked).
      const last = (await db.query<{ t: string | null }>(`SELECT app_photo_last_reconciliation() AS t`)).rows[0].t;
      const due = opts.reconcile === true || (opts.reconcile !== false && (!last || Date.now() - Date.parse(last) >= RECONCILE_EVERY_MS));
      if (due && isPhotoStorageConfigured()) {
        try { await reconcile(db, opts.mode, out, opts.testOverrides); out.reconciled = true; }
        catch (err) { errors.add(errName(err)); }
      }
    } finally {
      out.errorCodes = [...errors];
      try {
        await db.query(`SELECT app_photo_record_run($1::jsonb)`, [JSON.stringify({ ...out, startedAt: started.toISOString() })]);
      } catch (err) { console.error("Photo retention run log failed", { name: errName(err) }); }
      await db.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
  // Counts only: never keys, names or ids.
  // eslint-disable-next-line no-console
  console.log(`PHOTO_RETENTION_RUN ${JSON.stringify({ mode: out.mode, policy: out.policy, expiredDue: out.expiredDue, expiredMarked: out.expiredMarked,
    heldSkipped: out.heldSkipped, holdsLapsed: out.holdsLapsed, purgedVerified: out.purgedVerified, purgeFailed: out.purgeFailed,
    pendingOver24h: out.pendingOver24h, reconciled: out.reconciled, orphansFound: out.orphansFound, orphansDeleted: out.orphansDeleted,
    missingMarked: out.missingMarked, legalHeld: out.legalHeld, legalReviewOverdue: out.legalReviewOverdue, legalHeldMissing: out.legalHeldMissing,
    errorCodes: out.errorCodes })}`);
  if (out.pendingOver24h > 0) console.error("PHOTO_PURGE_ALERT", { pendingOver24h: out.pendingOver24h });
  // A legal hold never lapses: an overdue review only raises an alert; the photo is kept.
  if (out.legalReviewOverdue > 0) console.error("PHOTO_LEGAL_HOLD_REVIEW_OVERDUE", { count: out.legalReviewOverdue });
  if (out.legalHeldMissing > 0) console.error("PHOTO_LEGAL_HOLD_FILE_MISSING", { count: out.legalHeldMissing });
  return out;
}

/**
 * Orphans (objects with no photo row): only reported unless the policy is
 * APPROVED with purge enabled AND the object is older than the retention period
 * (it would have expired anyway; a younger one may belong to rows lost by a
 * database restore — kept, but unreachable). Missing files (live row, object
 * gone after a verified 404): tombstoned RECONCILED in "on"; counted in "simulate".
 */
async function reconcile(db: Q, mode: RetentionJobMode, out: RetentionRunResult, test?: RetentionTestOverrides) {
  const canDeleteOrphans = mode === "on" && out.policy?.status === "APPROVED" && out.policy.purgeEnabled;
  const retentionMs = test?.orphanDeleteMinAgeMs ?? (out.policy?.days ?? 30) * 86_400_000;
  const minAge = test?.orphanMinAgeMs ?? ORPHAN_MIN_AGE_MS;
  let token: string | undefined;
  do {
    const page = await listPhotoObjects("activity-photos/", token);
    token = page.next;
    if (page.items.length === 0) continue;
    const states = (await db.query<{ storage_key: string; state: string }>(`SELECT * FROM app_photo_classify_keys($1::text[])`, [page.items.map((i) => i.key)])).rows;
    const unknown = new Set(states.filter((s) => s.state === "unknown").map((s) => s.storage_key));
    for (const item of page.items) {
      if (!unknown.has(item.key)) continue;
      const age = item.lastModified ? Math.max(0, Date.now() - item.lastModified.getTime()) : 0;
      if (age < minAge) continue;
      out.orphansFound++;
      if (canDeleteOrphans && age >= retentionMs) {
        await deletePhotoObject(item.key);
        if (!(await photoObjectExists(item.key))) out.orphansDeleted++;
      }
    }
  } while (token);

  let after: string | null = null;
  for (;;) {
    const rows: { photo_id: string; storage_key: string }[] = (await db.query<{ photo_id: string; storage_key: string }>(
      `SELECT * FROM app_photo_live_keys($1::uuid, 200)`, [after])).rows;
    if (rows.length === 0) break;
    for (const r of rows) {
      after = r.photo_id;
      let present: boolean;
      try { present = await photoObjectExists(r.storage_key); } catch { continue; } // storage error: never a false "missing"
      if (present) continue;
      if (mode === "on") {
        const result = (await db.query<{ r: string }>(`SELECT app_photo_mark_missing($1::uuid) AS r`, [r.photo_id])).rows[0].r;
        if (result === "marked") out.missingMarked++;
        else if (result === "legal_hold") out.legalHeldMissing++; // evidence lost: reported, never tombstoned
      } else out.missingMarked++;
    }
  }
}

/** Starts the hourly job only when PHOTO_RETENTION_JOB is simulate/on (default off). */
export function startPhotoRetentionWorker(): () => void {
  const mode = env.PHOTO_RETENTION_JOB;
  if (mode === "off") return () => undefined;
  const tick = async () => {
    try { await runRetentionCycle({ mode, reconcile: "auto" }); }
    catch (err) { console.error("Photo retention job failed", { name: errName(err) }); }
  };
  void tick();
  const timer = setInterval(() => void tick(), env.PHOTO_RETENTION_INTERVAL_MINUTES * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
