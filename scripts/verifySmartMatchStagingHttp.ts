/**
 * Black-box verification of a DEPLOYED SmartMatch staging API over HTTPS,
 * using only the synthetic users created by seedSmartMatchStaging.ts.
 * No database access: everything goes through the public API, exactly as
 * the two portals do. Creates synthetic opportunities/applications only.
 *
 * Env:
 *   SMARTMATCH_STAGING_BASE_URL     e.g. https://<api>.up.railway.app (or http://127.0.0.1:PORT locally)
 *   SMARTMATCH_STAGING_WEB_ORIGIN   staging frontend origin, for the CORS check (optional)
 *   SMARTMATCH_STAGING_DEMO_PASSWORD
 */
const base = (process.env.SMARTMATCH_STAGING_BASE_URL ?? "").replace(/\/+$/, "");
const origin = process.env.SMARTMATCH_STAGING_WEB_ORIGIN ?? "";
const password = process.env.SMARTMATCH_STAGING_DEMO_PASSWORD ?? "";
if (!/^https:\/\/[a-z0-9-]+\.up\.railway\.app$/.test(base) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
  throw new Error("SMARTMATCH_STAGING_BASE_URL must be a Railway staging domain or a local address");
}
if (/app\.etnaracare\.com|etnara\.care/i.test(base)) throw new Error("Production refused");
if (password.length < 16) throw new Error("SMARTMATCH_STAGING_DEMO_PASSWORD is required");

type Json = Record<string, any>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

async function call(method: string, path: string, token?: string, body?: Json) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function session(email: string) {
  const login = await call("POST", "/auth/login", undefined, { email, password });
  check(`L login ${email}`, login.status === 200 && typeof login.body.token === "string", `status=${login.status}`);
  const token = login.body.token as string;
  const me = await call("GET", "/me", token);
  const orgId = (me.body.organizations ?? [])[0]?.id as string;
  await call("POST", "/me/active-organization", token, { organizationId: orgId });
  return { token, orgId, userId: me.body.user?.id as string };
}

/** Optionally wait for a fresh deployment to come up (SMARTMATCH_STAGING_WAIT_SECONDS). */
async function waitForHealth() {
  const deadline = Date.now() + Number(process.env.SMARTMATCH_STAGING_WAIT_SECONDS ?? 0) * 1000;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function smartmatchNotifications(token: string, appId: string) {
  const r = await call("GET", "/me/notifications?limit=100", token);
  return ((r.body.items ?? []) as Json[]).filter((n) => n.relatedEntityType === "smartmatch_application" && n.relatedEntityId === appId);
}

async function main() {
  await waitForHealth();
  const health = await call("GET", "/health");
  check("H1 /health responds", health.status === 200 && health.body.status === "ok", `status=${health.status}`);
  if (origin) {
    const allow = health.headers.get("access-control-allow-origin");
    check("H2 CORS allows the staging frontend origin", allow === origin, `allow-origin=${allow}`);
    const evil = await fetch(base + "/health", { headers: { Origin: "https://evil.example" } });
    check("H3 CORS does not allow an unknown origin", evil.headers.get("access-control-allow-origin") === null, `allow-origin=${evil.headers.get("access-control-allow-origin")}`);
  }

  const a1 = await session("admin1@agencia-a.invalid");
  const a2 = await session("admin2@agencia-a.invalid");
  const sup = await session("supervisor@agencia-a.invalid");
  const c1 = await session("cuidadora1@agencia-a.invalid");
  const c2 = await session("cuidadora2@agencia-a.invalid");
  const bAdmin = await session("admin@agencia-b.invalid");
  const bCg = await session("cuidadora@agencia-b.invalid");
  const S = `/organizations/${a1.orgId}/smartmatch`;
  const bad = await call("POST", "/auth/login", undefined, { email: "admin1@agencia-a.invalid", password: "wrong-password-123" });
  check("L wrong password rejected", bad.status === 401 || bad.status === 400, `status=${bad.status}`);

  // Unique schedule per run: +3..+9 days, 10:00-14:00 Puerto Rico (UTC-4).
  const days = 3 + Math.floor(Math.random() * 7);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 14, Math.floor(Math.random() * 50)));
  const window = { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3600e3).toISOString() };
  const consent = { consent: true, consentVersion: "smartmatch-consent-v1" };

  // Agency portal
  const draft = await call("POST", `${S}/opportunities`, a1.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a (staging)", ...window });
  check("A1 admin creates draft", draft.status === 201, `status=${draft.status}`);
  const oppId = draft.body.opportunity?.id as string;
  const pubB = await call("POST", `/organizations/${bAdmin.orgId}/smartmatch/opportunities/${oppId}/publish`, bAdmin.token);
  check("A2 agency B admin cannot publish agency A draft", pubB.status === 404, `status=${pubB.status}`);
  const pub = await call("POST", `${S}/opportunities/${oppId}/publish`, a2.token);
  check("A3 second admin (not the creator) publishes", pub.status === 200, `status=${pub.status}`);
  const supList = await call("GET", `${S}/opportunities`, sup.token);
  check("A4 supervisor has no SmartMatch access", supList.status === 403, `status=${supList.status}`);
  const net = await call("POST", `${S}/opportunities`, a1.token, { visibility: "NETWORK", regionLabel: "Caguas", roleLabel: "x", ...window });
  check("A5 NETWORK opportunities disabled", net.status === 409, `status=${net.status}`);
  const addr = await call("POST", `${S}/opportunities`, a1.token, { visibility: "INTERNAL", regionLabel: "Calle Luna 123, Caguas", roleLabel: "Cuidador/a", ...window });
  check("P1 address instead of municipality rejected", addr.status === 400, `status=${addr.status}`);
  const named = await call("POST", `${S}/opportunities`, a1.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidar a Sra. Rivera", ...window });
  check("P2 patient name in the role rejected", named.status === 400, `status=${named.status}`);

  // Caregiver portal
  const disc = await call("GET", `${S}/available-opportunities`, c1.token);
  check("C1 caregiver sees the published opportunity", disc.status === 200 && (disc.body.opportunities ?? []).some((o: Json) => o.id === oppId), `status=${disc.status}`);
  const discB = await call("GET", `/organizations/${bCg.orgId}/smartmatch/available-opportunities`, bCg.token);
  check("C2 agency B caregiver does not see it", !(discB.body.opportunities ?? []).some((o: Json) => o.id === oppId), `status=${discB.status}`);
  const noConsent = await call("POST", `${S}/opportunities/${oppId}/applications`, c1.token, {});
  check("C3 application without consent rejected", noConsent.status === 400, `status=${noConsent.status}`);
  const ap = await call("POST", `${S}/opportunities/${oppId}/applications`, c1.token, consent);
  check("C4 caregiver applies with consent", ap.status === 201, `status=${ap.status}`);
  const dup = await call("POST", `${S}/opportunities/${oppId}/applications`, c1.token, consent);
  check("C5 duplicate application rejected", dup.status === 409, `status=${dup.status}`);
  const wd = await call("POST", `${S}/applications/${ap.body.application?.id}/withdraw`, c1.token);
  check("C6 caregiver withdraws", wd.status === 200, `status=${wd.status}`);
  const re = await call("POST", `${S}/opportunities/${oppId}/applications`, c1.token, consent);
  check("C7 caregiver re-applies with renewed consent", re.status === 201, `status=${re.status}`);
  const appId = re.body.application?.id as string;
  const sub1 = await smartmatchNotifications(a1.token, appId);
  const sub2 = await smartmatchNotifications(a2.token, appId);
  check("N1 both agency admins notified of the new application", sub1.length === 1 && sub2.length === 1 && sub1[0].type === "SMARTMATCH_APPLICATION_SUBMITTED", `${sub1.length},${sub2.length}`);
  check("N2 agency B admin not notified", (await smartmatchNotifications(bAdmin.token, appId)).length === 0);
  check("N3 supervisor not notified", (await smartmatchNotifications(sup.token, appId)).length === 0);
  const ap2 = await call("POST", `${S}/opportunities/${oppId}/applications`, c2.token, consent);
  check("C8 second caregiver applies", ap2.status === 201, `status=${ap2.status}`);
  const crossApply = await call("POST", `/organizations/${bCg.orgId}/smartmatch/opportunities/${oppId}/applications`, bCg.token, consent);
  check("C9 agency B caregiver cannot apply", crossApply.status === 404, `status=${crossApply.status}`);

  // Agency review and decision
  const queue = await call("GET", `${S}/opportunities/${oppId}/review-queue`, a1.token);
  check("D1 review queue lists 3 applications (incl. withdrawn)", queue.status === 200 && (queue.body.applications ?? []).length === 3, `count=${(queue.body.applications ?? []).length}`);
  const review = await call("GET", `${S}/applications/${appId}/review`, a1.token);
  check("D2 live checks: approvable", review.status === 200 && review.body.checks?.approvable === true, JSON.stringify(review.body.checks ?? {}).slice(0, 120));
  const crossDecide = await call("POST", `/organizations/${bAdmin.orgId}/smartmatch/applications/${appId}/decision`, bAdmin.token, { decision: "REJECT" });
  check("D3 agency B admin cannot decide", crossDecide.status === 404, `status=${crossDecide.status}`);
  const noConfirm = await call("POST", `${S}/applications/${appId}/decision`, a1.token, { decision: "APPROVE" });
  check("D4 approval requires confirmation", noConfirm.status === 400, `status=${noConfirm.status}`);
  const ok = await call("POST", `${S}/applications/${appId}/decision`, a1.token, { decision: "APPROVE", confirm: true });
  check("D5 admin approves", ok.status === 200 && ok.body.outcome === "APPROVED", `status=${ok.status}`);
  const list = await call("GET", `${S}/opportunities`, a1.token);
  const opp = (list.body.opportunities ?? []).find((o: Json) => o.id === oppId);
  check("D6 opportunity is FILLED", opp?.status === "FILLED", `status=${opp?.status}`);
  const events = await call("GET", `${S}/applications/${appId}/events`, a2.token);
  const ev = (events.body.events ?? []) as Json[];
  check("D7 decision history SUBMITTED,APPROVED signed by admin 1", ev.map(e => e.event_type).join(",") === "SUBMITTED,APPROVED" && ev[1]?.actor_user_id === a1.userId, ev.map(e => e.event_type).join(","));
  const evCg = await call("GET", `${S}/applications/${appId}/events`, c1.token);
  check("D8 caregiver cannot read the agency history endpoint", evCg.status === 403, `status=${evCg.status}`);
  const mine1 = await call("GET", `${S}/my-applications`, c1.token);
  check("D9 caregiver 1 sees APPROVED", (mine1.body.applications ?? []).some((a: Json) => a.id === appId && a.status === "APPROVED"), "");
  const mine2 = await call("GET", `${S}/my-applications`, c2.token);
  const appr = await smartmatchNotifications(c1.token, appId);
  check("N4 caregiver notified of the approval", appr.length === 1 && appr[0].type === "SMARTMATCH_APPLICATION_APPROVED", appr.map((n) => n.type).join(","));
  const closed = await smartmatchNotifications(c2.token, ap2.body.application?.id);
  check("N5 other caregiver notified that the opportunity was covered", closed.length === 1 && closed[0].type === "SMARTMATCH_APPLICATION_CLOSED", closed.map((n) => n.type).join(","));
  check("N6 admins' request resolved after the decision", (await smartmatchNotifications(a2.token, appId)).every((n) => n.readAt));
  check("D10 caregiver 2 sees REJECTED / OPPORTUNITY_FILLED", (mine2.body.applications ?? []).some((a: Json) => a.opportunity_id === oppId && a.status === "REJECTED" && a.decision_reason === "OPPORTUNITY_FILLED"), "");

  // Reject path
  const d2 = await call("POST", `${S}/opportunities`, a2.token, { visibility: "INTERNAL", regionLabel: "Cayey", roleLabel: "Acompañante (staging)", ...window });
  const opp2 = d2.body.opportunity?.id as string;
  await call("POST", `${S}/opportunities/${opp2}/publish`, a1.token);
  const r = await call("POST", `${S}/opportunities/${opp2}/applications`, c2.token, consent);
  const rej = await call("POST", `${S}/applications/${r.body.application?.id}/decision`, a2.token, { decision: "REJECT" });
  check("R1 admin rejects; opportunity stays published", rej.status === 200, `status=${rej.status}`);

  const width = Math.max(...results.map(x => x.name.length));
  for (const x of results) console.log(`${x.pass ? "PASS" : "FAIL"}  ${x.name.padEnd(width)}  ${x.detail}`);
  const failed = results.filter(x => !x.pass).length;
  console.log(`\nSmartMatch staging HTTP (${base}): ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error("SmartMatch staging HTTP verification failed:", (err as Error).message); process.exit(1); });
