import express from "express";
import { describe, expect, it } from "vitest";
import { gatedFeatureFor, normalizeGatePath } from "../src/middleware/orgFeatureRules.js";

const O = "11111111-1111-4111-8111-111111111111", X = "22222222-2222-4222-8222-222222222222";
// One path per rule anchored with `$` (the ones a trailing slash used to skip), plus two `(/|$)` rules.
const PATHS: [string, string][] = [
  [`/organizations/${O}/shifts/${X}/private-instructions`, "SMARTMATCH"],
  [`/organizations/${O}/smartmatch/opportunities`, "SMARTMATCH"],
  [`/organizations/${O}/shifts/${X}/journey`, "EN_CAMINO"],
  [`/organizations/${O}/operations/journeys`, "EN_CAMINO"],
  [`/organizations/${O}/me/location-consent`, "EN_CAMINO"],
  [`/organizations/${O}/care-events/${X}/photo`, "ACTIVITY_PHOTOS"],
  [`/organizations/${O}/care-events/${X}/photo-eligibility`, "ACTIVITY_PHOTOS"],
  [`/organizations/${O}/shifts/${X}/photo-eligibility`, "ACTIVITY_PHOTOS"],
  [`/organizations/${O}/care-recipients/${X}/photo-receipt`, "ACTIVITY_PHOTOS"],
  [`/organizations/${O}/care-recipients/${X}/photo-recipients`, "ACTIVITY_PHOTOS"],
  [`/organizations/${O}/shifts/${X}/finance`, "FINANZAS"],
  [`/organizations/${O}/shifts/${X}/shift-reports`, "SHIFT_REPORTS"],
];

describe("feature gate: trailing slashes (I-2 residual, 4-nov)", () => {
  it("Express serves /x/ with the /x handler (and refuses /x//), so the gate must see /x/ as /x", async () => {
    const app = express();
    app.get("/organizations/:o/shifts/:s/private-instructions", (_req, res) => { res.json({ handled: true }); });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      for (const [suffix, status] of [["", 200], ["/", 200], ["//", 404]] as const) {
        const r = await fetch(`http://127.0.0.1:${port}/organizations/${O}/shifts/${X}/private-instructions${suffix}`);
        expect(r.status, suffix).toBe(status);
      }
    } finally { server.close(); }
  });

  it("every gated rule matches with one or more trailing slashes and any capitalisation", () => {
    for (const [path, feature] of PATHS) {
      for (const variant of [path, `${path}/`, `${path}//`, `${path.toUpperCase().replace(O.toUpperCase(), O)}/`]) {
        for (const method of ["GET", "POST", "PUT", "DELETE"]) {
          expect(gatedFeatureFor(variant, method)?.feature, `${method} ${variant}`).toBe(feature);
        }
      }
    }
  });

  it("a trailing slash never changes the read-only / legal-review decision", () => {
    for (const [p, m] of [[`/activity-photos`, "GET"], [`/activity-photos/${X}/image`, "GET"], [`/activity-photos/${X}/legal-hold`, "POST"],
      [`/activity-photos/${X}/review`, "POST"], [`/billing/invoices`, "GET"], [`/billing/invoices`, "POST"]]) {
      const base = gatedFeatureFor(`/organizations/${O}${p}`, m);
      expect(gatedFeatureFor(`/organizations/${O}${p}/`, m), `${m} ${p}/`).toEqual(base);
    }
  });

  it("normalizeGatePath only strips trailing slashes", () => {
    expect(normalizeGatePath("/")).toBe("/");
    expect(normalizeGatePath("///")).toBe("/");
    expect(normalizeGatePath("/a//b/")).toBe("/a//b");
  });
});
