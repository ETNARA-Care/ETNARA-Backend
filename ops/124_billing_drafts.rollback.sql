-- ROLLBACK of migration 124 (ETNARA Facturación Premium F2.2 — drafts).
-- Run ONLY as the database owner, in one go. A code-only rollback does NOT need
-- it: the F2.1 backend never reads these tables. Stops, changing nothing, if
-- any draft, line, reservation or tax treatment exists: those are financial
-- history and must be kept. 123 and Finanzas (119/121) are not touched.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoices) OR EXISTS (SELECT 1 FROM invoice_lines)
     OR EXISTS (SELECT 1 FROM invoice_shift_claims) OR EXISTS (SELECT 1 FROM finance_service_tax) THEN
    RAISE EXCEPTION 'billing drafts or tax treatments exist: rollback aborted, nothing changed';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.app_billing_live_claims(uuid, uuid[]);
DROP TABLE IF EXISTS invoice_shift_claims;
DROP TABLE IF EXISTS invoice_line_segments;
DROP TABLE IF EXISTS invoice_lines;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS finance_service_tax;
DROP FUNCTION IF EXISTS public.app_billing_f22_guard();

DELETE FROM schema_migrations WHERE filename = '124_billing_drafts.sql';

COMMIT;
