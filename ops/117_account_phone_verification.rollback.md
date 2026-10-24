# Migration 117 (phone linked to the account, SMS recovery): activation and rollback

## Off by default
Nothing is sent and every phone route answers 404 `FEATURE_NOT_ENABLED` until ALL of:
- `PHONE_VERIFICATION_ENABLED=true`
- `PHONE_CODE_SECRET` (random, 32+ characters; backend service only)
- `SMS_PROVIDER=twilio_verify` with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`
  (`SMS_PROVIDER=test` never sends and is refused in production).
Optional: `SMS_DAILY_CAP` (default 200 per day, all numbers), `PHONE_REQUIRED_SINCE` (staff accounts
created from that moment must link a phone; older accounts are only reminded).

Deploying 117 with the switch off changes only two things for users:
- logging in with a phone works only for a VERIFIED phone (none exists yet; e-mail login unchanged);
- a family invitation sent to a phone only matches a VERIFIED phone.

## Before activating (with Rafa's authorization)
1. Twilio account + Verify service; restrict Geo Permissions to +1; confirm Puerto Rico rates with Twilio.
2. Set the variables above on the backend service only (Railway), then test with 1–2 team numbers.

## Code-only rollback (recommended)
`PHONE_VERIFICATION_ENABLED=false` (immediate, no deploy needed beyond the variable), or redeploy the
previous backend. 117 can stay.

## Database rollback of 117 (only before real use)
`psql "$MIGRATIONS_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/117_account_phone_verification.rollback.sql`
- Stops, changing nothing, if any phone was verified or any SMS code was issued.
- Restores the 104 family-invitation function.
