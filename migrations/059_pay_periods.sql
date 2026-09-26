-- Fase 7.9: periodos de pago y cierre operativo
CREATE TABLE pay_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  date_from date NOT NULL,
  date_to date NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('weekly','biweekly','custom')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  approved_minutes integer NOT NULL DEFAULT 0,
  pay_amount_cents integer NOT NULL DEFAULT 0,
  bill_amount_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  closed_by_user_id uuid REFERENCES users(id),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_from <= date_to),
  UNIQUE (organization_id,date_from,date_to)
);
CREATE TABLE pay_period_timesheets (
  pay_period_id uuid NOT NULL REFERENCES pay_periods(id) ON DELETE RESTRICT,
  timesheet_id uuid NOT NULL REFERENCES timesheets(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  approved_minutes integer NOT NULL,
  pay_amount_cents integer NOT NULL,
  bill_amount_cents integer NOT NULL,
  PRIMARY KEY(pay_period_id,timesheet_id),
  UNIQUE(timesheet_id)
);
ALTER TABLE pay_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_period_timesheets ENABLE ROW LEVEL SECURITY;
CREATE POLICY pay_periods_org_manager ON pay_periods
USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY pay_period_timesheets_org_manager ON pay_period_timesheets
USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
GRANT SELECT,INSERT,UPDATE ON pay_periods TO app_runtime;
GRANT SELECT,INSERT ON pay_period_timesheets TO app_runtime;
