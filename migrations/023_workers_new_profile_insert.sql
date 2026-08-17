-- Migration 023: Workers — new global profile INSERT
-- workers_self_or_shared_org (014) is an ALL-commands policy whose USING
-- also governs INSERT's WITH CHECK. None of its three branches can ever be
-- true when creating a brand-new worker (user_id IS NULL, no membership
-- exists yet to reference) -- blocking the entire "link/create worker"
-- flow even for a legitimate organization admin. This is the same
-- bootstrap shape as the family_invitations/sessions/users fixes in
-- 020/021: the policy assumed the row already existed by the time anyone
-- needed to check it, but creating that first row is exactly the
-- operation being performed.

CREATE POLICY workers_insert_new_profile ON workers
    FOR INSERT
    WITH CHECK (
        (user_id IS NULL AND app_has_active_membership())
        OR app_is_superadmin()
    );
-- Deliberately narrow: only allows creating a worker with NO user_id yet
-- (an identity-less professional profile an org admin sets up before the
-- person has ever logged in -- exactly the schema's own documented intent
-- for workers.user_id being nullable). Never allows attaching an arbitrary
-- existing user_id to a new row -- that would let one org silently claim
-- someone else's account. Gated on app_has_active_membership() so only an
-- authenticated staff member of a real, active organization can do this,
-- not merely any authenticated user.
