-- SmartMatch invariant: at most one approved application per opportunity.
-- The approving service must lock the opportunity row and revalidate
-- eligibility, tenant manager authority, and vacancy in one transaction.
-- This unique index is the database-level final defense against races.
CREATE UNIQUE INDEX IF NOT EXISTS uq_smartmatch_one_approved_per_opportunity
  ON smartmatch_applications (opportunity_id)
  WHERE status = 'APPROVED';

-- Ensure decisions are attributable and pending requests cannot have
-- a recorded decision. Withdrawal is a caregiver action, not a decision.
ALTER TABLE smartmatch_applications
  ADD CONSTRAINT smartmatch_decision_consistency
  CHECK (
    (status IN ('PENDING','WITHDRAWN') AND decided_by_user_id IS NULL AND decided_at IS NULL)
    OR
    (status IN ('APPROVED','REJECTED') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  );

-- Restrict invalid expiration dates, even for drafts.
ALTER TABLE smartmatch_opportunities
  ADD CONSTRAINT smartmatch_expiration_after_creation
  CHECK (expires_at IS NULL OR expires_at > created_at);

-- Deliberately no grants, RLS policies or service endpoints in this migration.
