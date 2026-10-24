import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const strip = (s: string) => s.replace(/--.*$/gm, "");
const m115 = strip(readFileSync("migrations/115_activity_photos_security.sql", "utf8"));
const rollback = strip(readFileSync("ops/115_activity_photos_security.rollback.sql", "utf8"));

describe("migration 115: activity photos security", () => {
  it("removes the 014 policy and leaves app_runtime read-only on care_event_photos", () => {
    expect(m115).toMatch(/DROP POLICY IF EXISTS care_event_photos_via_care_event ON care_event_photos;/);
    expect(m115).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON care_event_photos FROM app_runtime;/);
    expect(m115).not.toMatch(/CREATE POLICY care_event_photos_\w+ ON care_event_photos FOR (ALL|INSERT|UPDATE|DELETE)/);
  });

  it("relatives read photo rows only through the checked function, never stored_files", () => {
    expect(m115).toMatch(/CREATE POLICY care_event_photos_family_read ON care_event_photos FOR SELECT[\s\S]*app_family_can_view_activity_photo\(id\)/);
    const storedFiles = m115.slice(m115.indexOf("CREATE POLICY stored_files_organizational_scope"), m115.indexOf("ALTER TABLE consent_records ADD COLUMN"));
    expect(storedFiles).not.toMatch(/care_event_photos|family_relationships|can_view_photos/);
  });

  it("family visibility requires approval, both consents, photo permission, active relationship and the switch", () => {
    const fn = m115.slice(m115.indexOf("FUNCTION public.app_family_can_view_activity_photo"), m115.indexOf("REVOKE ALL ON FUNCTION public.app_family_can_view_activity_photo"));
    for (const needle of ["NOT public.app_is_superadmin()", "p.share_status = 'approved'", "fr.can_view_photos = true", "fr.status = 'active'",
      "r.code = 'FAMILY'", "app_org_feature_enabled(p.organization_id, 'ACTIVITY_PHOTOS')", "c.id = p.capture_consent_id",
      "c.consent_type = 'PHOTO_SHARE_FAMILY'", "c.granted_at <= p.reviewed_at"]) {
      expect(fn).toContain(needle);
    }
  });

  it("every new SECURITY DEFINER function refuses ETNARA central and grants only to app_runtime", () => {
    expect(m115).not.toMatch(/\bTO\s+PUBLIC\b/i);
    for (const fn of ["app_attach_activity_photo", "app_review_activity_photo", "app_record_photo_consent", "app_revoke_photo_consent"]) {
      const body = m115.slice(m115.indexOf(`FUNCTION public.${fn}(`), m115.indexOf(`REVOKE ALL ON FUNCTION public.${fn}(`));
      expect(body).toMatch(/app_is_superadmin\(\)|app_photo_is_manager\(\)/);
      expect(m115).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO app_runtime;`));
    }
    expect(m115).toMatch(/FUNCTION public\.app_photo_is_manager\(\)[\s\S]*SELECT NOT public\.app_is_superadmin\(\)/);
  });

  it("the switch exists and is never turned on by the migration; nothing is deleted automatically", () => {
    expect(m115).toMatch(/feature_code IN \('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS'\)/);
    expect(m115).not.toMatch(/INSERT INTO\s+(public\.)?organization_features/i);
    expect(m115).not.toMatch(/DELETE FROM\s+(public\.)?(care_event_photos|stored_files|consent_records)/i);
  });
});

describe("rollback of 115 never reopens the holes", () => {
  it("keeps app_runtime without writes and does not restore the 014 policy or the 033 family branch", () => {
    expect(rollback).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*care_event_photos/i);
    expect(rollback).not.toMatch(/CREATE POLICY care_event_photos_via_care_event/);
    const storedFiles = rollback.slice(rollback.indexOf("CREATE POLICY stored_files_organizational_scope"), rollback.indexOf("DROP TRIGGER IF EXISTS stored_files_purpose_guard"));
    expect(storedFiles).not.toMatch(/care_event_photos|can_view_photos/);
    expect(rollback).not.toMatch(/\bTO\s+PUBLIC\b/i);
  });

  it("stops before touching anything if the feature was used, and re-checks after", () => {
    expect(rollback).toMatch(/^BEGIN;/m);
    expect(rollback).toMatch(/activity photos exist: rollback aborted/);
    expect(rollback).toMatch(/photo consents exist: rollback aborted/);
    expect(rollback).toMatch(/ACTIVITY_PHOTOS switch was used: rollback aborted/);
    expect(rollback).toMatch(/app_runtime would regain write access to care_event_photos: rollback aborted/);
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '115_activity_photos_security\.sql';/);
    expect(rollback).not.toMatch(/DELETE FROM schema_migrations[^;]*11[0-4]_/);
  });
});
