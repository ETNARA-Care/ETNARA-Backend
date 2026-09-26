-- Phase 8.0: auditable, idempotent escalation of real operational alerts.
CREATE TABLE operational_alert_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  alert_key text NOT NULL,
  category text NOT NULL CHECK (category IN ('uncovered_shift','missed_check_in','expiring_credential','open_incident','pending_timesheet')),
  related_entity_type text NOT NULL,
  related_entity_id uuid NOT NULL,
  escalated_by_user_id uuid NOT NULL REFERENCES users(id),
  escalated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, alert_key)
);

ALTER TABLE operational_alert_escalations ENABLE ROW LEVEL SECURITY;
CREATE POLICY operational_alert_escalations_manager_read ON operational_alert_escalations FOR SELECT
USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
GRANT SELECT ON operational_alert_escalations TO app_runtime;

CREATE UNIQUE INDEX idx_operational_alert_notification_once
ON notifications (user_id, notification_type, related_entity_id)
WHERE notification_type = 'OPERATIONAL_ALERT_ESCALATED' AND related_entity_type = 'operational_alert';

CREATE OR REPLACE FUNCTION app_escalate_operational_alert(
  p_organization_id uuid, p_alert_key text, p_category text,
  p_related_entity_type text, p_related_entity_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid; v_id uuid; v_valid boolean;
BEGIN
  v_user := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  IF p_organization_id IS DISTINCT FROM NULLIF(current_setting('app.current_org_id', true), '')::uuid
     OR v_user IS NULL OR NOT app_is_org_manager() THEN RAISE EXCEPTION 'operational escalation forbidden'; END IF;
  IF length(trim(p_alert_key)) NOT BETWEEN 1 AND 200
     OR p_alert_key <> p_category || ':' || p_related_entity_id::text
     OR p_related_entity_type <> CASE p_category
       WHEN 'uncovered_shift' THEN 'shift' WHEN 'missed_check_in' THEN 'shift'
       WHEN 'expiring_credential' THEN 'credential' WHEN 'open_incident' THEN 'incident'
       WHEN 'pending_timesheet' THEN 'timesheet' ELSE '' END
  THEN RAISE EXCEPTION 'invalid alert identity'; END IF;

  SELECT CASE p_category
    WHEN 'uncovered_shift' THEN EXISTS (SELECT 1 FROM shifts s WHERE s.id=p_related_entity_id AND s.organization_id=p_organization_id AND s.status<>'cancelled' AND s.scheduled_end>now() AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.shift_id=s.id AND a.organization_id=s.organization_id AND a.response_status='accepted'))
    WHEN 'missed_check_in' THEN EXISTS (SELECT 1 FROM shifts s WHERE s.id=p_related_entity_id AND s.organization_id=p_organization_id AND s.status<>'cancelled' AND s.scheduled_start<now()-interval '15 minutes' AND s.scheduled_end>now() AND EXISTS (SELECT 1 FROM assignments a WHERE a.shift_id=s.id AND a.response_status='accepted') AND NOT EXISTS (SELECT 1 FROM verification_events v WHERE v.shift_id=s.id AND v.event_type='check_in'))
    WHEN 'expiring_credential' THEN EXISTS (SELECT 1 FROM credentials c JOIN workers w ON w.id=c.worker_id JOIN organization_worker_memberships m ON m.worker_id=w.id WHERE c.id=p_related_entity_id AND m.organization_id=p_organization_id AND m.status='active' AND c.status='active' AND c.expires_at BETWEEN current_date AND current_date+30)
    WHEN 'open_incident' THEN EXISTS (SELECT 1 FROM incidents i WHERE i.id=p_related_entity_id AND i.organization_id=p_organization_id AND i.status<>'resolved')
    WHEN 'pending_timesheet' THEN EXISTS (SELECT 1 FROM timesheets t WHERE t.id=p_related_entity_id AND t.organization_id=p_organization_id AND t.status IN ('pending','disputed'))
    ELSE false END INTO v_valid;
  IF NOT v_valid THEN RAISE EXCEPTION 'operational alert no longer active'; END IF;

  INSERT INTO operational_alert_escalations (organization_id,alert_key,category,related_entity_type,related_entity_id,escalated_by_user_id)
  VALUES (p_organization_id,p_alert_key,p_category,p_related_entity_type,p_related_entity_id,v_user)
  ON CONFLICT (organization_id,alert_key) DO UPDATE SET alert_key=EXCLUDED.alert_key
  RETURNING id INTO v_id;

  INSERT INTO notifications (user_id,organization_id,notification_type,related_entity_type,related_entity_id,channel,status,sent_at)
  SELECT om.user_id,p_organization_id,'OPERATIONAL_ALERT_ESCALATED','operational_alert',v_id,'in_app','sent',now()
  FROM organization_memberships om JOIN user_roles ur ON ur.organization_membership_id=om.id JOIN roles r ON r.id=ur.role_id
  WHERE om.organization_id=p_organization_id AND om.status='active' AND r.code='SUPERVISOR'
  ON CONFLICT DO NOTHING;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app_escalate_operational_alert(uuid,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_escalate_operational_alert(uuid,text,text,text,uuid) TO app_runtime;
