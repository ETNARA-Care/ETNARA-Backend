-- Migration 016: Platform Seeds
-- Catalog data only -- no organizations, no users, no demo data of any
-- kind. Every insert is idempotent via ON CONFLICT DO NOTHING so this file
-- can be safely re-run.

-- ===================== ROLES =====================
INSERT INTO roles (code, name, description, is_system) VALUES
    ('PLATFORM_SUPERADMIN', 'Platform Superadmin', 'Full cross-organization platform access', true),
    ('ORGANIZATION_ADMIN',  'Organization Admin',  'Full administrative access within one organization', true),
    ('SUPERVISOR',          'Supervisor',          'Operational oversight within one organization', true),
    ('WORKER',              'Worker',              'Caregiver/professional executing assigned shifts', true),
    ('FAMILY',              'Family',              'Family member with access to a specific care recipient', true)
ON CONFLICT (code) DO NOTHING;

-- ===================== PERMISSIONS =====================
-- A minimal, reasonable starting set -- expected to grow as the RBAC layer
-- is wired into actual application endpoints. Deliberately not exhaustive.
INSERT INTO permissions (code, description) VALUES
    ('care_recipients.read',        'View care recipient records'),
    ('care_recipients.write',       'Create/edit care recipient records'),
    ('shifts.read',                 'View shifts'),
    ('shifts.write',                'Create/edit/assign shifts'),
    ('care_events.write',           'Record care events during a shift'),
    ('verification_events.write',   'Perform check-in/check-out'),
    ('verification_overrides.write','Authorize a supervisor override'),
    ('credentials.review',          'Review/verify worker credentials'),
    ('incidents.write',             'Report and manage incidents'),
    ('messages.write',              'Send messages within an authorized thread'),
    ('organization.admin',          'Manage organization settings and membership'),
    ('platform.admin',              'Superadmin-level platform operations')
ON CONFLICT (code) DO NOTHING;

-- ===================== CREDENTIAL TYPES =====================
INSERT INTO credential_types (code, name) VALUES
    ('IDENTITY',             'Government-issued Identification'),
    ('BACKGROUND_CHECK',     'Background Check'),
    ('LEY_300',               'Ley 300 / SICHDe Certification'),
    ('CPR',                  'CPR Certification'),
    ('BLS',                  'Basic Life Support Certification'),
    ('PROFESSIONAL_LICENSE', 'Professional License'),
    ('INTERNAL_TRAINING',    'Internal Platform Training Certificate')
ON CONFLICT (code) DO NOTHING;
-- LEY_300 is a row here, not a special case anywhere in application logic --
-- this is the concrete proof of the "never hardcode Ley 300" requirement.

-- ===================== VERIFICATION METHODS =====================
INSERT INTO verification_methods (code, name) VALUES
    ('PIN',                 'Family/Recipient PIN Verification'),
    ('SUPERVISOR_OVERRIDE', 'Supervisor Override')
    -- GPS, GEOFENCE, QR, NFC intentionally NOT seeded yet -- the catalog
    -- table exists and is ready, but their operational logic is not built.
ON CONFLICT (code) DO NOTHING;

-- ===================== CARE EVENT TYPES =====================
INSERT INTO care_event_types (code, name) VALUES
    ('MEAL',       'Meal / Feeding'),
    ('HYDRATION',  'Hydration'),
    ('TOILETING',  'Toileting'),
    ('MOBILITY',   'Mobility'),
    ('ACTIVITY',   'Activity'),
    ('MOOD',       'Mood / Emotional State'),
    ('NOTE',       'General Note'),
    ('PHOTO',      'Photo')
ON CONFLICT (code) DO NOTHING;
