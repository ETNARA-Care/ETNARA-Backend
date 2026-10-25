-- Migration 127 — ETNARA Facturación Premium F2.3: issuing, consecutive numbering,
-- immutable copy, private PDF documents, void, retention.
--
-- 1. billing_settings: the agency's invoice profile (legal name, address,
--    merchant registration, terms, footer, logo metadata), D9
--    show_caregiver_name (off by default), retention (min 6 years), and the
--    tax-configuration validation: REAL ISSUING IS REFUSED until the agency's
--    permissions manager records that the tax configuration was validated
--    (with a note). Nothing is preloaded.
-- 2. invoice_series: one row per agency; consecutive numbers without gaps
--    (the counter row is locked inside the issue transaction, so a rollback
--    also rolls the number back); next_number never decreases; the prefix is
--    frozen after the first issue. No PostgreSQL sequence (nextval leaves gaps).
-- 3. invoices: new states issued and voided. draft → issued (number + frozen
--    copies) and issued → voided (reason) are the only transitions; issued and
--    voided invoices are immutable (lines, segments and amounts too — already
--    guarded by 124). Unique (organization, number).
-- 4. invoice_documents: private PDF metadata (object key, SHA-256, size,
--    generator version). Insert only; the original is never replaced; the void
--    copy is a separate document.
-- 5. Reservations of a voided invoice are released (invoice_voided) so the
--    shifts can be billed again; reservations of an issued invoice stay live.
-- 6. An agency holiday used by a live issued invoice cannot be deactivated
--    (HOLIDAY_INVOICED).
-- RLS per capability (issue for issuing, void for voiding, manage for the
-- settings, view to read), RESTRICTIVE platform deny, no DELETE, guards that
-- also bind the table owner. Additive: no row of any other module changes.

-- 1. Settings ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  legal_name text CHECK (legal_name IS NULL OR length(trim(legal_name)) BETWEEN 2 AND 200),
  trade_name text CHECK (trade_name IS NULL OR length(trade_name) <= 200),
  address text CHECK (address IS NULL OR length(address) <= 400),
  phone text CHECK (phone IS NULL OR length(phone) <= 40),
  email text CHECK (email IS NULL OR length(email) <= 200),
  merchant_registration text CHECK (merchant_registration IS NULL OR length(merchant_registration) <= 60),
  payment_terms text CHECK (payment_terms IS NULL OR length(payment_terms) <= 300),
  footer_note text CHECK (footer_note IS NULL OR length(footer_note) <= 500),
  show_caregiver_name boolean NOT NULL DEFAULT false,
  retention_years integer NOT NULL DEFAULT 6 CHECK (retention_years BETWEEN 6 AND 30),
  logo_object_key text,
  logo_sha256 text CHECK (logo_sha256 IS NULL OR logo_sha256 ~ '^[0-9a-f]{64}$'),
  logo_content_type text CHECK (logo_content_type IS NULL OR logo_content_type IN ('image/png', 'image/jpeg')),
  tax_config_validated_at timestamptz,
  tax_config_validated_by_user_id uuid REFERENCES users(id),
  tax_validation_note text CHECK (tax_validation_note IS NULL OR length(trim(tax_validation_note)) BETWEEN 3 AND 500),
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_settings_tax_validation_shape CHECK (
    (tax_config_validated_at IS NULL AND tax_config_validated_by_user_id IS NULL AND tax_validation_note IS NULL)
    OR (tax_config_validated_at IS NOT NULL AND tax_config_validated_by_user_id IS NOT NULL AND tax_validation_note IS NOT NULL)),
  CONSTRAINT billing_settings_logo_shape CHECK ((logo_object_key IS NULL) = (logo_sha256 IS NULL) AND (logo_object_key IS NULL) = (logo_content_type IS NULL))
);

-- 2. Numbering --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_series (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  prefix text NOT NULL DEFAULT 'FAC' CHECK (prefix ~ '^[A-Z0-9]{1,6}$'),
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  first_issued_at timestamptz,
  updated_by_user_id uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Invoices: issued and voided ---------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_number integer,
  ADD COLUMN IF NOT EXISTS number_text text,
  ADD COLUMN IF NOT EXISTS issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS issued_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS issue_date date,
  ADD COLUMN IF NOT EXISTS issuer_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS client_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS totals_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS retention_until date,
  ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'discarded', 'issued', 'voided'));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_discard_shape;
ALTER TABLE invoices ADD CONSTRAINT invoices_discard_shape CHECK (
  (status <> 'discarded' AND discarded_at IS NULL AND discarded_by_user_id IS NULL AND discard_reason IS NULL AND discard_kind IS NULL)
  OR (status = 'discarded' AND discarded_at IS NOT NULL AND discarded_by_user_id IS NOT NULL
      AND length(trim(discard_reason)) BETWEEN 3 AND 300 AND discard_kind IS NOT NULL));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_issue_shape;
ALTER TABLE invoices ADD CONSTRAINT invoices_issue_shape CHECK (
  (status IN ('draft', 'discarded') AND invoice_number IS NULL AND number_text IS NULL AND issued_at IS NULL AND issued_by_user_id IS NULL
     AND issuer_snapshot IS NULL AND client_snapshot IS NULL AND totals_snapshot IS NULL AND retention_until IS NULL)
  OR (status IN ('issued', 'voided') AND invoice_number >= 1 AND number_text IS NOT NULL AND issued_at IS NOT NULL AND issued_by_user_id IS NOT NULL
     AND issue_date IS NOT NULL AND issuer_snapshot IS NOT NULL AND client_snapshot IS NOT NULL AND totals_snapshot IS NOT NULL AND retention_until IS NOT NULL));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_void_shape;
ALTER TABLE invoices ADD CONSTRAINT invoices_void_shape CHECK (
  (status <> 'voided' AND voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
  OR (status = 'voided' AND voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL AND length(trim(void_reason)) BETWEEN 3 AND 300));
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_org_number ON invoices (organization_id, invoice_number) WHERE invoice_number IS NOT NULL;

-- 4. Private PDF documents ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('original', 'void_copy')),
  object_key text NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 10 AND 300),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20000000),
  content_type text NOT NULL DEFAULT 'application/pdf' CHECK (content_type = 'application/pdf'),
  generator_version text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_documents_invoice_fkey FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices(id, organization_id),
  UNIQUE (invoice_id, kind)
);

-- 5. Reservations: released when an invoice is voided ------------------------------------
ALTER TABLE invoice_shift_claims DROP CONSTRAINT IF EXISTS invoice_shift_claims_release_kind_check;
ALTER TABLE invoice_shift_claims ADD CONSTRAINT invoice_shift_claims_release_kind_check
  CHECK (release_kind IS NULL OR release_kind IN ('line_removed', 'draft_discarded', 'abandoned_recovery', 'invoice_voided'));

-- 6. Guards ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_billing_f22_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER -- reads the parent invoice whatever the caller's row visibility
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_allowed text[];
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
    IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.created_by_user_id <> OLD.created_by_user_id
       OR NEW.created_at <> OLD.created_at OR NEW.billing_client_id <> OLD.billing_client_id THEN
      RAISE EXCEPTION 'INVOICE_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'DRAFT_CHANGED' USING ERRCODE = '40001'; END IF;
    IF OLD.status = 'draft' THEN
      IF NEW.status NOT IN ('draft', 'discarded', 'issued') THEN RAISE EXCEPTION 'INVOICE_TRANSITION_INVALID' USING ERRCODE = '55000'; END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
    IF OLD.status = 'issued' AND NEW.status = 'voided' THEN
      -- Voiding only records who, when and why: the issued copy never changes.
      v_allowed := ARRAY['status', 'voided_at', 'voided_by_user_id', 'void_reason', 'row_version', 'updated_at', 'updated_by_user_id'];
      IF (to_jsonb(NEW) - v_allowed) <> (to_jsonb(OLD) - v_allowed) THEN
        RAISE EXCEPTION 'INVOICE_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
    IF OLD.status IN ('issued', 'voided') THEN RAISE EXCEPTION 'INVOICE_IMMUTABLE' USING ERRCODE = '55000'; END IF;
    RAISE EXCEPTION 'INVOICE_NOT_EDITABLE' USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'invoice_documents' THEN
    IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'DOCUMENT_IMMUTABLE' USING ERRCODE = '55000'; END IF;
    SELECT status INTO v_status FROM invoices WHERE id = NEW.invoice_id;
    IF (NEW.kind = 'original' AND v_status IS DISTINCT FROM 'issued') OR (NEW.kind = 'void_copy' AND v_status IS DISTINCT FROM 'voided') THEN
      RAISE EXCEPTION 'DOCUMENT_STATE_MISMATCH' USING ERRCODE = '55000';
    END IF;
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
  -- An issued invoice keeps its shifts; only voiding releases them; a draft releases by its own rules.
  IF v_status = 'issued' THEN RAISE EXCEPTION 'CLAIM_INVOICED' USING ERRCODE = '55000'; END IF;
  IF v_status = 'voided' AND NEW.release_kind <> 'invoice_voided' THEN RAISE EXCEPTION 'CLAIM_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF v_status IN ('draft', 'discarded') AND NEW.release_kind = 'invoice_voided' THEN RAISE EXCEPTION 'CLAIM_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_billing_f22_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.app_billing_f23_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'BILLING_NO_DELETE' USING ERRCODE = '55000'; END IF;
  IF TG_TABLE_NAME = 'invoice_series' AND TG_OP = 'UPDATE' THEN
    IF NEW.next_number < OLD.next_number THEN RAISE EXCEPTION 'NUMBER_NEVER_DECREASES' USING ERRCODE = '55000'; END IF;
    IF NEW.prefix <> OLD.prefix AND OLD.first_issued_at IS NOT NULL THEN RAISE EXCEPTION 'PREFIX_LOCKED' USING ERRCODE = '55000'; END IF;
    IF OLD.first_issued_at IS NOT NULL AND NEW.first_issued_at IS DISTINCT FROM OLD.first_issued_at THEN RAISE EXCEPTION 'PREFIX_LOCKED' USING ERRCODE = '55000'; END IF;
    NEW.updated_at := now();
  END IF;
  IF TG_TABLE_NAME = 'billing_settings' AND TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_billing_f23_guard() FROM PUBLIC;

-- Holidays used by a live issued invoice stay as they were invoiced.
CREATE OR REPLACE FUNCTION public.app_billing_holiday_invoiced_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.active AND NOT NEW.active AND EXISTS (
    SELECT 1 FROM invoice_line_segments s
    JOIN invoice_lines l ON l.id = s.line_id AND l.removed_at IS NULL
    JOIN invoices i ON i.id = l.invoice_id AND i.status = 'issued'
    WHERE s.organization_id = OLD.organization_id AND s.segment_date = OLD.holiday_date AND s.day_type = 'holiday') THEN
    RAISE EXCEPTION 'HOLIDAY_INVOICED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_billing_holiday_invoiced_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS finance_holidays_billing_invoiced ON finance_holidays;
CREATE TRIGGER finance_holidays_billing_invoiced BEFORE UPDATE ON finance_holidays
  FOR EACH ROW EXECUTE FUNCTION public.app_billing_holiday_invoiced_guard();

DROP TRIGGER IF EXISTS invoice_documents_f22_guard ON invoice_documents;
CREATE TRIGGER invoice_documents_f22_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_documents
  FOR EACH ROW EXECUTE FUNCTION public.app_billing_f22_guard();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_settings', 'invoice_series'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_f23_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.app_billing_f23_guard()', t || '_f23_guard', t);
  END LOOP;
END $$;

-- 7. RLS ---------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_settings', 'invoice_series', 'invoice_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_finance_deny ON %I', t);
    EXECUTE format('CREATE POLICY platform_finance_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())', t);
  END LOOP;
  -- Anyone with a billing capability reads invoices, lines, segments, reservations, documents, settings and series.
  FOREACH t IN ARRAY ARRAY['invoices', 'invoice_lines', 'invoice_line_segments', 'invoice_shift_claims', 'invoice_documents', 'billing_settings', 'invoice_series'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_billing_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_runtime USING (public.app_billing_can(organization_id, ''view'') OR public.app_billing_can(organization_id, ''draft'') OR public.app_billing_can(organization_id, ''issue'') OR public.app_billing_can(organization_id, ''void'') OR public.app_billing_can(organization_id, ''manage''))', t || '_billing_read', t);
  END LOOP;
END $$;

-- Invoices: who may move each state (the guard decides which moves exist).
DROP POLICY IF EXISTS invoices_draft_update ON invoices;
DROP POLICY IF EXISTS invoices_lifecycle_update ON invoices;
CREATE POLICY invoices_lifecycle_update ON invoices FOR UPDATE TO app_runtime
  -- USING lets the row be locked (SELECT … FOR UPDATE) by anyone who can act on invoices, so a
  -- discarded or issued invoice answers «not editable» instead of «not found»; WITH CHECK and the
  -- guard decide what each capability may actually change.
  USING (public.app_billing_can(organization_id, 'draft') OR public.app_billing_can(organization_id, 'issue') OR public.app_billing_can(organization_id, 'void'))
  WITH CHECK ((status IN ('draft', 'discarded') AND public.app_billing_can(organization_id, 'draft'))
              OR (status = 'issued' AND public.app_billing_can(organization_id, 'issue'))
              OR (status = 'voided' AND public.app_billing_can(organization_id, 'void')));
GRANT UPDATE (invoice_number, number_text, issued_at, issued_by_user_id, issue_date, issuer_snapshot, client_snapshot, totals_snapshot,
  voided_at, voided_by_user_id, void_reason, retention_until) ON invoices TO app_runtime;

DROP POLICY IF EXISTS invoice_shift_claims_void_update ON invoice_shift_claims;
CREATE POLICY invoice_shift_claims_void_update ON invoice_shift_claims FOR UPDATE TO app_runtime
  USING (public.app_billing_can(organization_id, 'void'))
  WITH CHECK (public.app_billing_can(organization_id, 'void') AND release_kind = 'invoice_voided');

DROP POLICY IF EXISTS invoice_documents_insert ON invoice_documents;
CREATE POLICY invoice_documents_insert ON invoice_documents FOR INSERT TO app_runtime
  WITH CHECK ((kind = 'original' AND public.app_billing_can(organization_id, 'issue'))
              OR (kind = 'void_copy' AND public.app_billing_can(organization_id, 'void')));
GRANT SELECT, INSERT ON invoice_documents TO app_runtime;

DROP POLICY IF EXISTS billing_settings_manage_write ON billing_settings;
CREATE POLICY billing_settings_manage_write ON billing_settings FOR INSERT TO app_runtime
  WITH CHECK (public.app_billing_can(organization_id, 'manage'));
DROP POLICY IF EXISTS billing_settings_manage_update ON billing_settings;
CREATE POLICY billing_settings_manage_update ON billing_settings FOR UPDATE TO app_runtime
  USING (public.app_billing_can(organization_id, 'manage')) WITH CHECK (public.app_billing_can(organization_id, 'manage'));
GRANT SELECT, INSERT ON billing_settings TO app_runtime;
GRANT UPDATE (legal_name, trade_name, address, phone, email, merchant_registration, payment_terms, footer_note, show_caregiver_name,
  retention_years, logo_object_key, logo_sha256, logo_content_type, tax_config_validated_at, tax_config_validated_by_user_id,
  tax_validation_note, updated_by_user_id, updated_at) ON billing_settings TO app_runtime;

-- Series: the manager sets the prefix (before the first issue); issuing advances the counter.
DROP POLICY IF EXISTS invoice_series_insert ON invoice_series;
CREATE POLICY invoice_series_insert ON invoice_series FOR INSERT TO app_runtime
  WITH CHECK (public.app_billing_can(organization_id, 'manage') OR public.app_billing_can(organization_id, 'issue'));
DROP POLICY IF EXISTS invoice_series_update ON invoice_series;
CREATE POLICY invoice_series_update ON invoice_series FOR UPDATE TO app_runtime
  USING (public.app_billing_can(organization_id, 'manage') OR public.app_billing_can(organization_id, 'issue'))
  WITH CHECK (public.app_billing_can(organization_id, 'manage') OR public.app_billing_can(organization_id, 'issue'));
GRANT SELECT, INSERT ON invoice_series TO app_runtime;
GRANT UPDATE (prefix, next_number, first_issued_at, updated_by_user_id, updated_at) ON invoice_series TO app_runtime;

-- 8. Reservation facts now say whether the shift is in a draft or already invoiced --------
DROP FUNCTION IF EXISTS public.app_billing_live_claims(uuid, uuid[]);
CREATE FUNCTION public.app_billing_live_claims(p_organization_id uuid, p_shift_ids uuid[])
RETURNS TABLE (shift_id uuid, invoice_id uuid, claimed_by_email text, claimed_at timestamptz, invoice_status text, number_text text)
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
  SELECT c.shift_id, c.invoice_id, u.email::text, c.claimed_at, i.status, i.number_text
  FROM public.invoice_shift_claims c
  JOIN public.users u ON u.id = c.claimed_by_user_id
  JOIN public.invoices i ON i.id = c.invoice_id
  WHERE c.organization_id = p_organization_id AND c.released_at IS NULL AND c.shift_id = ANY (p_shift_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.app_billing_live_claims(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_billing_live_claims(uuid, uuid[]) TO app_runtime;
