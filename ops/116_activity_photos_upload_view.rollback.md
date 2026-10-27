# Activity photos PR 2 (migration 116): deploy prerequisites and rollback

## Before deploying
1. **Separate private bucket for photos** (decision 4): DONE 2026-10-24 —
   `etnara-activity-photos` in the production Railway project, environment
   `production`, region `ams` (same as the database). Railway buckets are
   private (public buckets are not supported); nothing is ever made public.
2. DONE 2026-10-24 (as `${{etnara-activity-photos.*}}` references, backend
   service only, no redeploy) — the variables, never the documents bucket's
   `STORAGE_*` values:
   `PHOTO_STORAGE_ENDPOINT`, `PHOTO_STORAGE_REGION`, `PHOTO_STORAGE_BUCKET`,
   `PHOTO_STORAGE_ACCESS_KEY_ID`, `PHOTO_STORAGE_SECRET_ACCESS_KEY`,
   `PHOTO_STORAGE_FORCE_PATH_STYLE` (as the bucket's credentials indicate).
   Optional: `PHOTO_MAX_UPLOAD_BYTES` (default 15 MB, maximum 20 MB).
   `PHOTO_STORAGE_FORCE_PATH_STYLE=false` (the bucket uses virtual-host URLs).
3. Without them every photo route answers 503 `PHOTO_STORAGE_NOT_CONFIGURED`
   (and 404 while `ACTIVITY_PHOTOS` is off, which is the default). If they
   point at the documents bucket, the API also refuses (503).
4. Keep `ACTIVITY_PHOTOS` off for every agency until the pilot is approved.

## Right after deploying: private-bucket check (no credentials leave Railway)
- The backend runs it by itself once at start. In the backend logs look for
  `PHOTO_STORAGE_SELF_CHECK PASS {...}`: all seven values must be `true`
  (configured, separate from documents, credentials accepted, synthetic probe
  written and read back, anonymous read refused, anonymous listing refused,
  probe deleted). The line contains only yes/no values.
- Manual re-run inside the service (optional): `railway ssh` into the backend,
  then `npx tsx scripts/checkPhotoStorage.ts` (exit 0 = all pass).
- `FAIL` → do not enable `ACTIVITY_PHOTOS`; photo routes stay off (404) anyway.
  Fix the bucket/variables and redeploy; nothing else depends on it.

## Code-only rollback (recommended)
Redeploy the previous backend. 115 and 116 stay: the previous backend never
calls the 116 functions. Objects already in the photo bucket stay private.

## Database rollback of 116 (only before any real use)
`psql "$MIGRATIONS_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/116_activity_photos_upload_view.rollback.sql`
- Stops, changing nothing, if any photo, view, photo consent or photo/consent-form file exists.
- Never touches 115: the security model and its closed holes stay.

## After real use
Fix forward. To stop the feature at once switch `ACTIVITY_PHOTOS` off for the
agency: uploads, reviews and family views stop immediately (404).
