-- Migration 020: Auth Bootstrap RLS
-- Adds three narrowly-scoped, SELECT-only, additive RLS policies required
-- to make login/session-lookup/org-listing possible at all. Each follows
-- the same pattern already established in this schema: the backend sets a
-- session-scoped GUC to the exact value it is searching for (never raw
-- client input), and the policy only ever exposes the row(s) matching that
-- specific value. None of these policies touch INSERT/UPDATE/DELETE on any
-- table, and none weaken any previously-approved tenant isolation.

-- ---------------------------------------------------------------------
-- 1. users: lookup by login identifier (email or phone) -- required for
--    login itself, before any user_id is known.
-- ---------------------------------------------------------------------
CREATE POLICY users_login_lookup ON users
    FOR SELECT
    USING (
        lower(email) = NULLIF(current_setting('app.lookup_identifier', true), '')
        OR phone = NULLIF(current_setting('app.lookup_identifier', true), '')
    );

-- ---------------------------------------------------------------------
-- 2. sessions: lookup by token_hash -- required by the auth middleware to
--    resolve a raw session token into a user identity before current_user_id
--    is known. Security is provided by the token itself being an
--    unguessable 256-bit value the backend computed server-side, not by
--    row-level ownership (the same trust model as sending the token as a
--    Bearer credential in the first place).
-- ---------------------------------------------------------------------
CREATE POLICY sessions_token_lookup ON sessions
    FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.lookup_token_hash', true), ''));

-- ---------------------------------------------------------------------
-- 3. organization_memberships / organizations / user_roles: allow an
--    authenticated user to discover their OWN memberships, orgs, and roles
--    across ALL organizations (needed for GET /me) without already knowing
--    which organization_id to scope to.
-- ---------------------------------------------------------------------
CREATE POLICY organization_memberships_self_lookup ON organization_memberships
    FOR SELECT
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY organizations_self_membership_lookup ON organizations
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM organization_memberships om
            WHERE om.organization_id = organizations.id
              AND om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND om.status = 'active'
        )
    );

CREATE POLICY user_roles_self_lookup ON user_roles
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM organization_memberships om
            WHERE om.id = user_roles.organization_membership_id
              AND om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
    );
