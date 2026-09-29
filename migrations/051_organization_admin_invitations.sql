-- E.4.2: reserve the organization administrator invitation enum value.
-- PostgreSQL requires a newly-added enum value to be committed before it can
-- be referenced by constraints, indexes or functions. The dependent schema
-- changes therefore live in migration 052.
ALTER TYPE access_invitation_type_enum ADD VALUE IF NOT EXISTS 'organization_admin';
