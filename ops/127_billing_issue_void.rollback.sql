-- ROLLBACK of migration 127 (ETNARA Facturación Premium F2.3 — issue, numbering, PDF, void).
-- Run ONLY as the database owner, in one go. Stops, changing nothing, if any
-- invoice was ever issued or voided, any document stored, any number taken or
-- any billing profile saved: those are fiscal records and must be kept. A
-- code-only rollback (F2.2 backend) needs nothing: it never issues and its
-- guard refuses to edit issued invoices anyway.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoices WHERE status IN ('issued', 'voided') OR invoice_number IS NOT NULL)
     OR EXISTS (SELECT 1 FROM invoice_documents) OR EXISTS (SELECT 1 FROM invoice_series) OR EXISTS (SELECT 1 FROM billing_settings) THEN
    RAISE EXCEPTION 'issued invoices, documents, numbering or billing profile exist: rollback aborted, nothing changed';
  END IF;
END $$;

DROP TRIGGER IF EXISTS finance_holidays_billing_invoiced ON finance_holidays;
DROP FUNCTION IF EXISTS public.app_billing_holiday_invoiced_guard();
DROP TABLE IF EXISTS invoice_documents;
DROP TABLE IF EXISTS invoice_series;
DROP TABLE IF EXISTS billing_settings;
DROP FUNCTION IF EXISTS public.app_billing_f23_guard();

DROP POLICY IF EXISTS invoices_lifecycle_update ON invoices;
CREATE POLICY invoices_draft_update ON invoices FOR UPDATE TO app_runtime
  USING (public.app_billing_can(organization_id, 'draft')) WITH CHECK (public.app_billing_can(organization_id, 'draft'));
DROP POLICY IF EXISTS invoice_shift_claims_void_update ON invoice_shift_claims;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'invoice_lines', 'invoice_line_segments', 'invoice_shift_claims'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_billing_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_runtime USING (public.app_billing_can(organization_id, ''view'') OR public.app_billing_can(organization_id, ''draft''))', t || '_billing_read', t);
  END LOOP;
END $$;
REVOKE UPDATE (invoice_number, number_text, issued_at, issued_by_user_id, issue_date, issuer_snapshot, client_snapshot, totals_snapshot,
  voided_at, voided_by_user_id, void_reason, retention_until) ON invoices FROM app_runtime;

DROP INDEX IF EXISTS idx_invoices_org_number;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_void_shape;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_issue_shape;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_discard_shape;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'discarded'));
ALTER TABLE invoices ADD CONSTRAINT invoices_discard_shape CHECK (
  (status = 'draft' AND discarded_at IS NULL AND discarded_by_user_id IS NULL AND discard_reason IS NULL AND discard_kind IS NULL)
  OR (status = 'discarded' AND discarded_at IS NOT NULL AND discarded_by_user_id IS NOT NULL
      AND length(trim(discard_reason)) BETWEEN 3 AND 300 AND discard_kind IS NOT NULL));
ALTER TABLE invoices
  DROP COLUMN IF EXISTS invoice_number, DROP COLUMN IF EXISTS number_text, DROP COLUMN IF EXISTS issued_at, DROP COLUMN IF EXISTS issued_by_user_id,
  DROP COLUMN IF EXISTS issue_date, DROP COLUMN IF EXISTS issuer_snapshot, DROP COLUMN IF EXISTS client_snapshot, DROP COLUMN IF EXISTS totals_snapshot,
  DROP COLUMN IF EXISTS voided_at, DROP COLUMN IF EXISTS voided_by_user_id, DROP COLUMN IF EXISTS void_reason, DROP COLUMN IF EXISTS retention_until,
  DROP COLUMN IF EXISTS legal_hold;

ALTER TABLE invoice_shift_claims DROP CONSTRAINT IF EXISTS invoice_shift_claims_release_kind_check;
ALTER TABLE invoice_shift_claims ADD CONSTRAINT invoice_shift_claims_release_kind_check
  CHECK (release_kind IS NULL OR release_kind IN ('line_removed', 'draft_discarded', 'abandoned_recovery'));

-- 124's guard and reservation function, exactly as 124 created them.
DROP FUNCTION IF EXISTS public.app_billing_live_claims(uuid, uuid[]);
CREATE OR REPLACE FUNCTION public.app_billing_f22_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER -- reads the parent draft whatever the caller's row visibility
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BILLING_NO_DELETE' USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'finance_service_tax' THEN
    IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'TAX_TREATMENT_IMMUTABLE' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'invoices' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'INVOICE_MUST_START_AS_DRAFT' USING ERRCODE = '55000'; END IF;
      RETURN NEW;
    END IF;
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'INVOICE_NOT_EDITABLE' USING ERRCODE = '55000'; END IF;
    IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.created_by_user_id <> OLD.created_by_user_id
       OR NEW.created_at <> OLD.created_at OR NEW.billing_client_id <> OLD.billing_client_id THEN
      RAISE EXCEPTION 'INVOICE_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'DRAFT_CHANGED' USING ERRCODE = '40001'; END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- Lines, segments and claims belong to a draft: only while it is a draft.
  IF TG_TABLE_NAME = 'invoice_line_segments' THEN
    SELECT i.status INTO v_status FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.id = NEW.line_id;
    IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'INVOICE_NOT_EDITABLE' USING ERRCODE = '55000'; END IF;
    IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'SEGMENT_IMMUTABLE' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status FROM invoices WHERE id = NEW.invoice_id;

  IF TG_TABLE_NAME = 'invoice_lines' THEN
    IF TG_OP = 'INSERT' THEN
      IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'INVOICE_NOT_EDITABLE' USING ERRCODE = '55000'; END IF;
      RETURN NEW;
    END IF;
    -- UPDATE: only removing the line (once), while the draft is a draft.
    IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'INVOICE_NOT_EDITABLE' USING ERRCODE = '55000'; END IF;
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
       OR (to_jsonb(NEW) - ARRAY['removed_at','removed_by_user_id','remove_reason']) <> (to_jsonb(OLD) - ARRAY['removed_at','removed_by_user_id','remove_reason']) THEN
      RAISE EXCEPTION 'LINE_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- invoice_shift_claims
  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'INVOICE_NOT_EDITABLE' USING ERRCODE = '55000'; END IF;
    IF NEW.released_at IS NOT NULL THEN RAISE EXCEPTION 'CLAIM_IMMUTABLE' USING ERRCODE = '55000'; END IF;
    IF NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.id = NEW.line_id AND l.invoice_id = NEW.invoice_id AND l.kind = 'shift' AND l.shift_id = NEW.shift_id) THEN
      RAISE EXCEPTION 'CLAIM_LINE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['released_at','released_by_user_id','release_reason','release_kind'])
        <> (to_jsonb(OLD) - ARRAY['released_at','released_by_user_id','release_reason','release_kind']) THEN
    RAISE EXCEPTION 'CLAIM_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_billing_f22_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.app_billing_live_claims(p_organization_id uuid, p_shift_ids uuid[])
RETURNS TABLE (shift_id uuid, invoice_id uuid, claimed_by_email text, claimed_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT (public.app_billing_can(p_organization_id, 'view') OR public.app_billing_can(p_organization_id, 'draft')) THEN
    RAISE EXCEPTION 'BILLING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.shift_id, c.invoice_id, u.email::text, c.claimed_at
  FROM public.invoice_shift_claims c JOIN public.users u ON u.id = c.claimed_by_user_id
  WHERE c.organization_id = p_organization_id AND c.released_at IS NULL AND c.shift_id = ANY (p_shift_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.app_billing_live_claims(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_billing_live_claims(uuid, uuid[]) TO app_runtime;

DELETE FROM schema_migrations WHERE filename = '127_billing_issue_void.sql';

COMMIT;
