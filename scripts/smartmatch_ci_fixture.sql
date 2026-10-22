-- Synthetic-only fixture for GitHub Actions. NEVER apply to ETNARA production.
CREATE ROLE app_runtime NOLOGIN;
CREATE TABLE organizations (id uuid PRIMARY KEY);
CREATE TABLE users (id uuid PRIMARY KEY);
CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid NOT NULL REFERENCES organizations(id), status text NOT NULL
);
CREATE TABLE roles (id uuid PRIMARY KEY, code text NOT NULL);
CREATE TABLE user_roles (
  organization_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  role_id uuid NOT NULL REFERENCES roles(id)
);
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT ON organization_memberships, roles, user_roles TO app_runtime;
INSERT INTO organizations VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO users VALUES
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222');
INSERT INTO roles VALUES ('33333333-3333-4333-8333-333333333333','ORGANIZATION_ADMIN');
INSERT INTO organization_memberships VALUES
 ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active'),
 ('55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','active');
INSERT INTO user_roles VALUES
 ('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333'),
 ('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333');
