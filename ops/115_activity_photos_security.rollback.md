# Rollback — activity photos security (migration 115)

## Rule
The security part of 115 is never undone. No step here gives app_runtime write
access to `care_event_photos`, restores the 014 policy (any member reads and
links photo rows), or restores the 033 family branch on `stored_files`.

## 1. Code-only rollback (recommended)
1. Railway → `etnara-care-backend` → redeploy the previous deployment.
2. Leave 115 applied. The previous backend never wrote photos (no file could be
   created); a `PHOTO` activity would now answer an error instead of linking
   an arbitrary file, which is the intended behaviour.
3. Keep `ACTIVITY_PHOTOS` off for every agency (it is off by default).

## 2. Database rollback of 115 (only before any real use)
1. Do step 1 first and note the PITR recovery time.
2. As the database owner: `psql "$MIGRATIONS_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/115_activity_photos_security.rollback.sql`
3. It changes nothing and stops if any photo, photo consent, photo/consent-form
   file, or `ACTIVITY_PHOTOS` switch row (or its history) exists.
4. Result: the photo feature is gone. `care_event_photos` is readable by agency
   managers only and written by nobody through the API; relatives have no
   access to `stored_files`.
5. Roll forward later by redeploying the new backend (the pre-deploy applies 115 again).

## 3. After real use
Photos, consents and their history are evidence (who captured, who approved,
under which consent). Do not run the database rollback; fix forward. To stop
the feature at once, switch `ACTIVITY_PHOTOS` off for the agency: relatives
lose access immediately and nothing new can be attached.

## Not allowed
- `GRANT INSERT|UPDATE|DELETE ON care_event_photos TO app_runtime`.
- Re-creating `care_event_photos_via_care_event` (014) or the 033 family branch.
- Deleting rows from `care_event_photo_events` or photo `consent_records`.
