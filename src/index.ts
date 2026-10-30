import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { startupDatabaseCheck } from "./config/dbRuntimeRole.js";
import { photoStorageSelfCheck, photoStorageSelfCheckPassed } from "./modules/activityPhotos/photoStorage.js";
import { startCoverageEscalationWorker } from "./modules/coverageOffers/coverageEscalation.worker.js";
import { startLateArrivalWorker } from "./modules/verification/verification.arrival.js";
import { startShiftReportWorker } from "./modules/shiftReports/shiftReportsCaregiver.service.js";

const app = createApp();

// Security audit 26-oct: the database role is checked before accepting traffic (see dbRuntimeRole.ts).
// Non-blocking by default; DB_STARTUP_FAIL_CLOSED / REQUIRE_RESTRICTED_DB_ROLE are only for the switch to app_runtime.
await startupDatabaseCheck({
  connectionString: env.DATABASE_URL,
  requireRestricted: process.env.REQUIRE_RESTRICTED_DB_ROLE === "true",
  failClosed: process.env.DB_STARTUP_FAIL_CLOSED === "true",
});

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`ETNARA Care backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startCoverageEscalationWorker();
  startLateArrivalWorker();
  // Informe de Turno F2 (128): drafts appear when a visit ends; counts only in logs.
  startShiftReportWorker();
  // Activity photos: once per start, only if the private photo bucket is configured.
  // Logs yes/no values only (no keys, names or URLs); never blocks the server.
  void photoStorageSelfCheck().then((r) => {
    if (!r.configured) return;
    // eslint-disable-next-line no-console
    console.log(`PHOTO_STORAGE_SELF_CHECK ${photoStorageSelfCheckPassed(r) ? "PASS" : "FAIL"} ${JSON.stringify(r)}`);
  }).catch(() => undefined);
});
