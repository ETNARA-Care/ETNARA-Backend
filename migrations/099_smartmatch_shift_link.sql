-- Migration 099: SmartMatch -> Turnos ("Crear turno con esta cuidadora").
--
-- Approval keeps meaning "opportunity FILLED, no assignment yet". An agency
-- administrator may later create ONE real shift in the existing Turnos
-- module (shifts + assignments) for the approved caregiver. This migration
-- only adds:
--   1. smartmatch_opportunities.shift_id: the link, at most one shift per
--      opportunity and one opportunity per shift, same agency (composite FK),
--      only on FILLED opportunities, write-once.
--   2. shift_private_instructions: operational instructions for a shift,
--      kept OUT of the shifts row on purpose. shifts rows are readable by
--      family members (shifts_family_read) and by the platform super-admin
--      (ETNARA central / Tower); this table is readable only by managers of
--      the shift's agency and by the worker currently assigned to the shift.
-- No existing table, policy or column of Turnos is changed.

-- 1. Link ---------------------------------------------------------------
ALTER TABLE smartmatch_opportunities ADD COLUMN IF NOT EXISTS shift_id uuid NULL;

ALTER TABLE smartmatch_opportunities
  ADD CONSTRAINT smartmatch_opportunities_shift_same_org
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id);

ALTER TABLE smartmatch_opportunities
  ADD CONSTRAINT smartmatch_opportunities_shift_only_when_filled
  CHECK (shift_id IS NULL OR status = 'FILLED');

CREATE UNIQUE INDEX IF NOT EXISTS idx_smartmatch_opportunities_shift_once
  ON smartmatch_opportunities (shift_id) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.app_smartmatch_opportunity_shift_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.shift_id IS DISTINCT FROM OLD.shift_id AND OLD.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'SMARTMATCH_SHIFT_LINK_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_smartmatch_opportunity_shift_link ON smartmatch_opportunities;
CREATE TRIGGER trg_smartmatch_opportunity_shift_link
  BEFORE UPDATE OF shift_id ON smartmatch_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_opportunity_shift_link();

-- Same row policies as every other admin update (096): own agency, admin.
GRANT UPDATE (shift_id) ON smartmatch_opportunities TO app_runtime;

-- 2. Private operational instructions ----------------------------------
CREATE TABLE IF NOT EXISTS shift_private_instructions (
  shift_id           uuid PRIMARY KEY,
  organization_id    uuid NOT NULL,
  instructions       text NOT NULL CHECK (char_length(btrim(instructions)) BETWEEN 1 AND 2000),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id)
);

ALTER TABLE shift_private_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_private_instructions FORCE ROW LEVEL SECURITY;

-- Managers (ORGANIZATION_ADMIN / SUPERVISOR) of the shift's own agency.
-- Deliberately no app_is_superadmin(): ETNARA central / Tower get nothing.
CREATE POLICY shift_private_instructions_manager_read
ON shift_private_instructions FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_manager()
);
CREATE POLICY shift_private_instructions_manager_insert
ON shift_private_instructions FOR INSERT TO app_runtime
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND created_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_is_org_manager()
);
CREATE POLICY shift_private_instructions_manager_update
ON shift_private_instructions FOR UPDATE TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_manager()
)
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_manager()
);
-- The worker assigned to the shift (pending or accepted, while the shift is
-- current), using the same helper Turnos uses for shift access.
CREATE POLICY shift_private_instructions_assigned_worker_read
ON shift_private_instructions FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_worker_has_shift_assignment(shift_id)
);
-- No family policy and no DELETE: absent policy = no access.
-- Same restrictive platform PHI deny as shifts and every clinical table (078):
-- the platform super-admin (ETNARA central / Tower) never reads these rows.
CREATE POLICY platform_phi_deny ON shift_private_instructions
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

GRANT SELECT ON shift_private_instructions TO app_runtime;
GRANT INSERT (shift_id, organization_id, instructions, created_by_user_id)
  ON shift_private_instructions TO app_runtime;
GRANT UPDATE (instructions, updated_at) ON shift_private_instructions TO app_runtime;
