-- Migration 027: verification_methods -- baseline self-check-in method
-- verification_methods was explicitly designed as an extensible catalog
-- (see comment in 010: "extensible for GPS/GEOFENCE/QR/NFC later without a
-- [schema] migration"). Only PIN and SUPERVISOR_OVERRIDE were seeded in
-- 016. PIN has no actual secret-storage backing anywhere in the schema
-- (confirmed by inspection -- no PIN column exists on any table), so it
-- cannot be securely validated and is not implemented as a functional
-- check-in method in this gate (tests marked N/A, documented in the
-- report). SUPERVISOR_OVERRIDE requires an authorizing supervisor and is
-- fully modeled via verification_overrides.
--
-- Neither covers the single most common case this gate must support: a
-- caregiver, authenticated via their own session, checking themselves in
-- for their own assigned shift, with no additional secret exchange. This
-- adds exactly one catalog row for that case -- purely additive data, no
-- structural change.
INSERT INTO verification_methods (code, name)
VALUES ('CAREGIVER_SESSION', 'Caregiver Authenticated Session');
