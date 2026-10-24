# Rollback — SmartMatch fixes (migrations 110, 111 and 112)

## Rule
Migration **111 is never rolled back.** It removed PUBLIC's access to
`password_reset_tokens` (every database login could read reset-token hashes).
No step here grants anything on that table to PUBLIC. The API connects as
`app_runtime`, the only role that needs it (SELECT, INSERT, UPDATE).

## 1. Code-only rollback (recommended)
1. Railway → `etnara-care-backend` → redeploy the previous deployment (`8274cce`).
2. GitHub Pages → revert the frontend PR (#221).
3. Leave 110, 111 and 112 applied. The previous backend works with them (it
   does not call the new functions).

## 2. Database rollback of 110 and 112 (only if their objects must go)
1. Do step 1 first.
2. Note the PITR recovery time.
3. As the database owner: `psql "$MIGRATIONS_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/110_111_smartmatch_fixes.rollback.sql`
4. The script runs in one transaction and changes nothing if:
   - overnight availability windows exist (the agency must edit them first);
   - PUBLIC holds any privilege on `password_reset_tokens`;
   - `app_runtime` is missing SELECT/INSERT/UPDATE on it.
5. Roll forward later by redeploying the new backend: the pre-deploy applies 110 and 112 again.

## 3. Password recovery fails after a deploy or rollback
Symptom: `/auth/password-reset/*` returns 500, logs show `permission denied for table password_reset_tokens`.

Diagnose (as the owner):
```sql
SELECT current_user;  -- run inside the app: must be app_runtime
SELECT has_table_privilege('app_runtime','public.password_reset_tokens','SELECT') AS sel,
       has_table_privilege('app_runtime','public.password_reset_tokens','INSERT') AS ins,
       has_table_privilege('app_runtime','public.password_reset_tokens','UPDATE') AS upd;
SELECT a.grantee::regrole, a.privilege_type
FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.password_reset_tokens'::regclass;
```

Fix — grant to the application role only, never PUBLIC:
```sql
BEGIN;
GRANT SELECT, INSERT, UPDATE ON public.password_reset_tokens TO app_runtime;
REVOKE ALL ON public.password_reset_tokens FROM PUBLIC;
COMMIT;
```

If the API is not connecting as `app_runtime`, the `DATABASE_URL` of the
service is wrong. Correct the variable in Railway (`app_runtime` user). Never
widen the grant to make a wrong role work.

Last resort: PITR to the time noted before the deploy.

## Not allowed
- `GRANT ... ON password_reset_tokens TO PUBLIC`.
- `DELETE FROM schema_migrations WHERE filename = '111_...'`.
