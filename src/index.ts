import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { photoStorageSelfCheck, photoStorageSelfCheckPassed } from "./modules/activityPhotos/photoStorage.js";
import { startCoverageEscalationWorker } from "./modules/coverageOffers/coverageEscalation.worker.js";
import { startLateArrivalWorker } from "./modules/verification/verification.arrival.js";

const app = createApp();

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`ETNARA Care backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startCoverageEscalationWorker();
  startLateArrivalWorker();
  // Activity photos: once per start, only if the private photo bucket is configured.
  // Logs yes/no values only (no keys, names or URLs); never blocks the server.
  void photoStorageSelfCheck().then((r) => {
    if (!r.configured) return;
    // eslint-disable-next-line no-console
    console.log(`PHOTO_STORAGE_SELF_CHECK ${photoStorageSelfCheckPassed(r) ? "PASS" : "FAIL"} ${JSON.stringify(r)}`);
  }).catch(() => undefined);
});
