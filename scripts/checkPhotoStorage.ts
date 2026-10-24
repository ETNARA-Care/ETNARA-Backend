/**
 * Activity photos — private bucket check, for use INSIDE the backend service
 * (e.g. `railway ssh` into the backend, then `npx tsx scripts/checkPhotoStorage.ts`),
 * so the credentials never leave Railway. The backend also runs the same check
 * once at every start (log line PHOTO_STORAGE_SELF_CHECK).
 * Prints only yes/no values. Exit code 0 = all checks passed.
 */
import { photoStorageSelfCheck, photoStorageSelfCheckPassed } from "../src/modules/activityPhotos/photoStorage.js";

const r = await photoStorageSelfCheck();
const rows: Array<[string, boolean]> = [
  ["Photo bucket configured (PHOTO_STORAGE_*)", r.configured],
  ["Separate from the documents bucket", r.separateFromDocuments],
  ["Backend credentials accepted", r.authenticated],
  ["Write + read back a synthetic probe", r.roundTrip],
  ["Anonymous read of the probe refused (401/403)", r.anonymousReadDenied],
  ["Anonymous listing of the bucket refused (401/403)", r.anonymousListDenied],
  ["Probe deleted", r.cleanedUp],
];
for (const [label, ok] of rows) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
if (r.error) console.log(`error: ${r.error}`);
const passed = photoStorageSelfCheckPassed(r);
console.log(passed ? "Photo storage: ALL PASS" : "Photo storage: FAIL");
process.exit(passed ? 0 : 1);
