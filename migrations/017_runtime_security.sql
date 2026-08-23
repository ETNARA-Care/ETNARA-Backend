-- Migration 017: Runtime Security
-- Creates the least-privilege PostgreSQL role the application connects as,
-- and the minimal additive table needed to make Superadmin verification a
-- real table lookup instead of a trusted session flag.

-- =====================================================================
-- ARCHITECTURE CHANGE (additive only -- see chat explanation):
-- Superadmin is a platform-level identity, not tied to any single
-- organization_membership. This table exists so app_is_superadmin() can
-- check a real row instead of trusting app.is_superadmin blindly.
-- =====================================================================
CREATE TABLE platform_admins (
    user_id             uuid PRIMARY KEY REFERENCES users(id),
    granted_at          timestamptz NOT NULL DEFAULT now(),
    granted_by_user_id  uuid REFERENCES users(id),
    revoked_at          timestamptz NULL
);

-- =====================================================================
-- APP_RUNTIME ROLE
-- =====================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        CREATE ROLE app_runtime WITH
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            NOBYPASSRLS
            CONNECTION LIMIT -1
            PASSWORD 'CHANGE_ME_IN_DEPLOYMENT';
    END IF;
END
$$;
-- least privilege confirmed: no SUPERUSER, no BYPASSRLS (RLS policies apply
-- to this role exactly as designed -- without NOBYPASSRLS being explicit,
-- an admin could accidentally grant bypass later without noticing), no
-- CREATEDB/CREATEROLE/REPLICATION.

GRANT CONNECT ON DATABASE caretest TO app_runtime;
-- NOTE: replace 'caretest' with the real deployment database name.

GRANT USAGE ON SCHEMA public TO app_runtime;

-- Baseline: SELECT/INSERT/UPDATE/DELETE on all application tables. This is
-- intentionally broad at the table-privilege level -- the real, granular
-- protection is Row Level Security (014, 018), which filters WHICH ROWS
-- app_runtime can see or touch. Table-level GRANTs and RLS are two
-- different layers; both matter, but RLS is where tenant isolation lives.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;

-- Sequences: NOT needed. Every primary key in this schema uses
-- gen_random_uuid() as its DEFAULT, not a serial/bigserial column, so there
-- are no sequences to grant USAGE on. Confirmed by inspecting the schema --
-- zero sequences exist in this database.

-- =====================================================================
-- AUDIT LOG: append-only, enforced at the privilege level, not just by
-- application discipline.
-- =====================================================================
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_runtime;
GRANT SELECT, INSERT ON audit_log TO app_runtime;
-- app_runtime can never UPDATE, DELETE, or TRUNCATE this table, at the
-- PostgreSQL grant level -- no application code path can violate this,
-- because the database itself will reject the attempt regardless of what
-- SQL is sent.

-- Administrative maintenance (e.g. a required legal redaction, or archival
-- partitioning) remains possible for the table owner (the role that ran
-- migrations, e.g. app_test / the deployment migration role) or any
-- explicitly elevated superuser session -- never for app_runtime.
