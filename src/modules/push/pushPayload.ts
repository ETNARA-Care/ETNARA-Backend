/**
 * Declarative Web Push format (WebKit, iOS 18.4+): Safari shows it even without running the
 * service worker; older browsers hand the same JSON to sw.js. Only the fixed catalogue text
 * and the opaque link (/abrir?n=<notice id>): the server decides the destination when it opens.
 * Pure (no env, no database) so it is unit-tested.
 */
export function pushOpenUrl(appBaseUrl: string, notificationId: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}/abrir?n=${encodeURIComponent(notificationId)}`;
}

export function buildPushPayload(job: { notification_id: string; title: string; body: string }, appBaseUrl: string): string {
  return JSON.stringify({
    web_push: 8030,
    notification: { title: job.title, body: job.body, navigate: pushOpenUrl(appBaseUrl, job.notification_id), lang: "es-PR", dir: "ltr", silent: false },
  });
}
