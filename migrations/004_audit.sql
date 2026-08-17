CREATE TABLE audit_log (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id       uuid NULL REFERENCES users(id),
    organization_id     uuid NULL REFERENCES organizations(id),
    target_organization_id uuid NULL REFERENCES organizations(id),
    action              text NOT NULL,
    entity_type         text NOT NULL,
    entity_id           uuid NULL,
    occurred_at         timestamptz NOT NULL DEFAULT now(),
    previous_value      jsonb,
    new_value           jsonb,
    ip_address          inet,
    device_metadata     jsonb
);

CREATE INDEX idx_audit_log_organization_id ON audit_log (organization_id);
CREATE INDEX idx_audit_log_target_organization_id ON audit_log (target_organization_id) WHERE target_organization_id IS NOT NULL;
CREATE INDEX idx_audit_log_actor_user_id ON audit_log (actor_user_id);
CREATE INDEX idx_audit_log_occurred_at ON audit_log (occurred_at DESC);
CREATE INDEX idx_audit_log_entity_lookup ON audit_log (entity_type, entity_id);
