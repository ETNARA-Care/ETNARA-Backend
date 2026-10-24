# Activity photos PR 2 (migration 116): deploy prerequisites and rollback

## Before deploying
1. **Separate private bucket for photos** (decision 4): in Railway → project
   `hopeful-education` → environment `production` → *Create bucket*
   (e.g. `etnara-activity-photos`, same region as the database, `ams`).
   Railway buckets are private; nothing is ever made public.
2. Set on the backend service ONLY these variables, from that bucket's
   credentials (never reuse the documents bucket `STORAGE_*` values):
   `PHOTO_STORAGE_ENDPOINT`, `PHOTO_STORAGE_REGION`, `PHOTO_STORAGE_BUCKET`,
   `PHOTO_STORAGE_ACCESS_KEY_ID`, `PHOTO_STORAGE_SECRET_ACCESS_KEY`,
   `PHOTO_STORAGE_FORCE_PATH_STYLE` (as the bucket's credentials indicate).
   Optional: `PHOTO_MAX_UPLOAD_BYTES` (default 15 MB, maximum 20 MB).
3. Without them every photo route answers 503 `PHOTO_STORAGE_NOT_CONFIGURED`
   (and 404 while `ACTIVITY_PHOTOS` is off, which is the default). If they
   point at the documents bucket, the API also refuses (503).
4. Keep `ACTIVITY_PHOTOS` off for every agency until the pilot is approved.

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
