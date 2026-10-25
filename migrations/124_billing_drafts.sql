-- Migration 124 — ETNARA Facturación Premium F2.2: drafts, lines, shift reservations, tax treatment.
--
-- 1. finance_service_tax: tax treatment per service, versioned by date and
--    append-only. Three states (taxable with a rate / exempt with a legal basis
--    / pending). NOTHING is preloaded: a service without a row is "pending".
-- 2. invoices: in F2.2 only DRAFT and DISCARDED exist (the CHECK allows nothing
--    else, so no invoice can be issued until F2.3 extends it). Optimistic
--    locking with row_version. Client and period are copied on the draft.
-- 3. invoice_lines (shift / manual / discount): never deleted — a removed line
--    keeps its row with removed_at and the reason. invoice_line_segments: the
--    overnight segments (D8) with the rate used by each.
-- 4. invoice_shift_claims: a shift can be reserved by ONE live draft only
--    (partial unique index). Released only by removing the line, discarding the
--    draft or the audited recovery of an inactive draft; never automatically.
-- Every table: RLS by billing capability (view to read, draft to write,
-- manage for tax treatment), RESTRICTIVE platform deny, no DELETE grant,
-- composite (id, organization_id) keys so nothing crosses agencies, and guards
-- that also bind the table owner.
--
-- Additive only: no existing table, row, rate or shift is changed.

-- 1. Tax treatment ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_service_tax (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  service_id uuid NOT NULL,
  treatment text NOT NULL CHECK (treatment IN ('taxable', 'exempt', 'pending')),
  rate_basis_points integer,
  legal_basis text,
  validation_note text,
  effective_from date NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_service_tax_service_fkey FOREIGN KEY (service_id, organization_id) REFERENCES finance_services(id, organization_id),
  CONSTRAINT finance_service_tax_shape CHECK (
    (treatment = 'taxable' AND rate_basis_points BETWEEN 1 AND 5000 AND legal_basis IS NULL)
    OR (treatment = 'exempt' AND rate_basis_points IS NULL AND length(trim(legal_basis)) BETWEEN 3 AND 300)
    OR (treatment = 'pending' AND rate_basis_points IS NULL AND legal_basis IS NULL)),
  CONSTRAINT finance_service_tax_note CHECK (validation_note IS NULL OR length(validation_note) <= 300),
  UNIQUE (service_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_finance_service_tax_org ON finance_service_tax (organization_id, service_id, effective_from DESC);

-- 2. Invoices (drafts in F2.2) -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'discarded')),
  billing_client_id uuid NOT NULL,
  client_name text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 200),
  period_from date NOT NULL,
  period_to date NOT NULL,
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  discarded_at timestamptz,
  discarded_by_user_id uuid REFERENCES users(id),
  discard_reason text,
  discard_kind text CHECK (discard_kind IS NULL OR discard_kind IN ('discarded', 'abandoned_recovery')),
  UNIQUE (id, organization_id),
  CONSTRAINT invoices_client_fkey FOREIGN KEY (billing_client_id, organization_id) REFERENCES billing_clients(id, organization_id),
  CONSTRAINT invoices_period CHECK (period_to >= period_from AND period_to - period_from <= 92),
  CONSTRAINT invoices_discard_shape CHECK (
    (status = 'draft' AND discarded_at IS NULL AND discarded_by_user_id IS NULL AND discard_reason IS NULL AND discard_kind IS NULL)
    OR (status = 'discarded' AND discarded_at IS NOT NULL AND discarded_by_user_id IS NOT NULL
        AND length(trim(discard_reason)) BETWEEN 3 AND 300 AND discard_kind IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices (organization_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('shift', 'manual', 'discount')),
  shift_id uuid,
  care_recipient_id uuid,
  recipient_name text CHECK (recipient_name IS NULL OR length(recipient_name) <= 200),
  -- Caregiver name(s) frozen when the shift line is computed (shown on the PDF only if the agency allows it, D9).
  caregiver_name text CHECK (caregiver_name IS NULL OR length(caregiver_name) <= 300),
  service_id uuid,
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 300),
  justification text CHECK (justification IS NULL OR length(trim(justification)) BETWEEN 3 AND 500),
  service_date date NOT NULL,
  real_start timestamptz,
  real_end timestamptz,
  approved_minutes integer CHECK (approved_minutes IS NULL OR approved_minutes BETWEEN 1 AND 2880),
  -- D4: the approved timesheets this shift line was computed from (reference kept, never edited).
  timesheet_ids uuid[] NOT NULL DEFAULT '{}',
  unit text CHECK (unit IS NULL OR unit IN ('hour', 'shift', 'day', 'fixed', 'unit')),
  quantity_hundredths integer NOT NULL CHECK (quantity_hundredths >= 0),
  unit_price_cents integer CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
  amount_cents integer NOT NULL,
  tax_treatment text NOT NULL CHECK (tax_treatment IN ('taxable', 'exempt', 'pending')),
  tax_rate_basis_points integer,
  tax_legal_basis text,
  needs_review boolean NOT NULL DEFAULT false,
  review_reasons text[] NOT NULL DEFAULT '{}',
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  position integer NOT NULL DEFAULT 0,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users(id),
  remove_reason text,
  UNIQUE (id, organization_id),
  CONSTRAINT invoice_lines_invoice_fkey FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices(id, organization_id),
  CONSTRAINT invoice_lines_shift_fkey FOREIGN KEY (shift_id, organization_id) REFERENCES shifts(id, organization_id),
  CONSTRAINT invoice_lines_recipient_fkey FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients(id, organization_id),
  CONSTRAINT invoice_lines_service_fkey FOREIGN KEY (service_id, organization_id) REFERENCES finance_services(id, organization_id),
  CONSTRAINT invoice_lines_kind_shape CHECK (
    (kind = 'shift' AND shift_id IS NOT NULL AND service_id IS NOT NULL AND real_start IS NOT NULL AND approved_minutes IS NOT NULL)
    OR (kind = 'manual' AND shift_id IS NULL AND justification IS NOT NULL AND amount_cents >= 0)
    OR (kind = 'discount' AND shift_id IS NULL AND justification IS NOT NULL AND amount_cents <= 0)),
  CONSTRAINT invoice_lines_tax_shape CHECK (
    (tax_treatment = 'taxable' AND tax_rate_basis_points BETWEEN 1 AND 5000)
    OR (tax_treatment = 'exempt' AND tax_rate_basis_points IS NULL AND length(trim(tax_legal_basis)) >= 3)
    OR (tax_treatment = 'pending' AND tax_rate_basis_points IS NULL)),
  CONSTRAINT invoice_lines_remove_shape CHECK (
    (removed_at IS NULL AND removed_by_user_id IS NULL AND remove_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (invoice_id, position) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_lines_recipient_date ON invoice_lines (organization_id, care_recipient_id, service_date) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS invoice_line_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  line_id uuid NOT NULL,
  segment_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  -- D1: approved minutes allocated to this real segment in proportion to its real time (0 allowed:
  -- a few real seconds before midnight may receive no approved minute; the segment is kept for the trace).
  minutes integer NOT NULL CHECK (minutes BETWEEN 0 AND 1440),
  billable_minutes integer NOT NULL CHECK (billable_minutes >= minutes),
  timesheet_id uuid,
  rate_id uuid,
  rate_source text CHECK (rate_source IS NULL OR rate_source IN ('client', 'general')),
  day_type text CHECK (day_type IS NULL OR day_type IN ('standard', 'holiday')),
  holiday_name text,
  unit_price_cents integer,
  amount_cents integer NOT NULL,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT invoice_line_segments_line_fkey FOREIGN KEY (line_id, organization_id) REFERENCES invoice_lines(id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_line_segments_line ON invoice_line_segments (line_id, starts_at);

CREATE TABLE IF NOT EXISTS invoice_shift_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_id uuid NOT NULL,
  claimed_by_user_id uuid NOT NULL REFERENCES users(id),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by_user_id uuid REFERENCES users(id),
  release_reason text,
  release_kind text CHECK (release_kind IS NULL OR release_kind IN ('line_removed', 'draft_discarded', 'abandoned_recovery')),
  CONSTRAINT invoice_shift_claims_shift_fkey FOREIGN KEY (shift_id, organization_id) REFERENCES shifts(id, organization_id),
  CONSTRAINT invoice_shift_claims_invoice_fkey FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices(id, organization_id),
  CONSTRAINT invoice_shift_claims_line_fkey FOREIGN KEY (line_id, organization_id) REFERENCES invoice_lines(id, organization_id),
  CONSTRAINT invoice_shift_claims_release_shape CHECK (
    (released_at IS NULL AND released_by_user_id IS NULL AND release_kind IS NULL)
    OR (released_at IS NOT NULL AND released_by_user_id IS NOT NULL AND release_kind IS NOT NULL))
);
-- D3: one live reservation per shift, whoever tries second gets a unique violation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_shift_claims_live ON invoice_shift_claims (shift_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_shift_claims_invoice ON invoice_shift_claims (invoice_id) WHERE released_at IS NULL;

-- 3. Guards (also for the table owner) ---------------------------------------------------
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

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_service_tax', 'invoices', 'invoice_lines', 'invoice_line_segments', 'invoice_shift_claims'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_f22_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.app_billing_f22_guard()', t || '_f22_guard', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_billing_read', t);
    -- Read: billing.view, or billing.draft (to work on drafts); the tax table also for the manager.
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO app_runtime USING (public.app_billing_can(organization_id, ''view'') OR public.app_billing_can(organization_id, ''draft'')%s)',
      t || '_billing_read', t, CASE WHEN t = 'finance_service_tax' THEN ' OR public.app_billing_can(organization_id, ''manage'')' ELSE '' END);
    EXECUTE format('DROP POLICY IF EXISTS platform_finance_deny ON %I', t);
    EXECUTE format('CREATE POLICY platform_finance_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())', t);
  END LOOP;
END $$;

-- Tax treatment: written by the permissions manager (agency configuration).
DROP POLICY IF EXISTS finance_service_tax_manage_insert ON finance_service_tax;
CREATE POLICY finance_service_tax_manage_insert ON finance_service_tax FOR INSERT TO app_runtime
  WITH CHECK (public.app_billing_can(organization_id, 'manage'));
GRANT SELECT, INSERT ON finance_service_tax TO app_runtime;

-- Drafts, lines, segments and reservations: billing.draft.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'invoice_lines', 'invoice_line_segments', 'invoice_shift_claims'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_draft_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO app_runtime WITH CHECK (public.app_billing_can(organization_id, ''draft''))', t || '_draft_insert', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO app_runtime', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invoices', 'invoice_lines', 'invoice_shift_claims'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_draft_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO app_runtime USING (public.app_billing_can(organization_id, ''draft'')) WITH CHECK (public.app_billing_can(organization_id, ''draft''))', t || '_draft_update', t);
  END LOOP;
END $$;
GRANT UPDATE (period_from, period_to, notes, row_version, updated_by_user_id, updated_at, status,
  discarded_at, discarded_by_user_id, discard_reason, discard_kind) ON invoices TO app_runtime;
GRANT UPDATE (removed_at, removed_by_user_id, remove_reason) ON invoice_lines TO app_runtime;
GRANT UPDATE (released_at, released_by_user_id, release_reason, release_kind) ON invoice_shift_claims TO app_runtime;

-- 4. Who holds a shift (for «Reservado en el borrador de …»), without exposing
--    drafts to people without billing.view: only reservation facts, same agency.
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
