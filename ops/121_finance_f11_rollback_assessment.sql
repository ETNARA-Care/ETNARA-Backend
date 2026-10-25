-- READ-ONLY assessment before reverting Finanzas F1.1 (migration 121).
-- Changes nothing (SELECT only, read-only transaction). Run as the owner or any
-- role that can read the finance tables, BEFORE choosing a recovery path.
--
-- Why: the automatic rollback (ops/121_…rollback.sql) refuses to run once a
-- rate was cancelled or a holiday deactivated, because dropping those columns
-- would bring a cancelled price or a removed holiday back into force. For the
-- same reason the F1 code (abc9436) must NOT serve Finanzas while such rows
-- exist: it does not know `cancelled_at` / `active`, so on the days of a
-- cancelled change it would see two prices, and a deactivated holiday again.
--
-- Decision (see claude/finanzas-f1-1-cierre-y-despliegue.md):
--   all counts 0      → code rollback to abc9436 is safe; the rollback script may run.
--   any count > 0     → keep FINANZAS OFF for the affected agencies before (or instead
--                       of) a code rollback, and fix forward; never run the rollback
--                       script; never re-enable FINANZAS on the F1 code.

BEGIN TRANSACTION READ ONLY;

SELECT 'cancelled_rates' AS check, count(*) AS n FROM finance_rates WHERE cancelled_at IS NOT NULL
UNION ALL
SELECT 'deactivated_holidays', count(*) FROM finance_holidays WHERE NOT active OR deactivated_at IS NOT NULL
UNION ALL
SELECT 'rates_reopened_by_a_cancel', count(*) FROM finance_events WHERE action = 'FINANCE_RATE_REOPENED'
UNION ALL
-- Days on which the F1 code would see more than one price for the same line.
SELECT 'line_days_ambiguous_for_f1_code', count(*) FROM (
  SELECT c.id, d::date
  FROM finance_rates c
  CROSS JOIN LATERAL generate_series(c.effective_from, COALESCE(c.effective_to, c.effective_from + 366), interval '1 day') d
  WHERE c.cancelled_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM finance_rates r
      WHERE r.id <> c.id AND r.cancelled_at IS NULL
        AND r.organization_id = c.organization_id AND r.service_id = c.service_id
        AND r.rate_kind = c.rate_kind AND r.scope = c.scope AND r.day_type = c.day_type
        AND r.billing_client_id IS NOT DISTINCT FROM c.billing_client_id
        AND r.organization_worker_membership_id IS NOT DISTINCT FROM c.organization_worker_membership_id
        AND r.effective_from <= d::date AND (r.effective_to IS NULL OR r.effective_to >= d::date))
) x;

-- Which agencies are affected (ids only; FINANZAS must stay off for them on the F1 code).
SELECT organization_id, 'cancelled_rates' AS reason, count(*) AS n FROM finance_rates WHERE cancelled_at IS NOT NULL GROUP BY organization_id
UNION ALL
SELECT organization_id, 'deactivated_holidays', count(*) FROM finance_holidays WHERE NOT active GROUP BY organization_id
ORDER BY 1, 2;

-- Which agencies have FINANZAS on right now.
SELECT organization_id, feature_code, enabled FROM organization_features WHERE feature_code = 'FINANZAS' AND enabled;

ROLLBACK;
