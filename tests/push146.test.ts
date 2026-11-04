import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notificationTargetPath } from "../src/modules/push/pushTarget.js";
import { buildPushPayload } from "../src/modules/push/pushPayload.js";

const S = "33333333-3333-4333-8333-333333333333", E = "44444444-4444-4444-8444-444444444444";
const migration = readFileSync(new URL("../migrations/146_web_push_notifications.sql", import.meta.url), "utf8");
const catalog = [...migration.matchAll(/\('([A-Z_]+)',\s+'(agency|caregiver|family|self)',\s+'ETNARA Care',\s+'([^']+)',\s+(\d+),\s+'(normal|high)'\)/g)]
  .map(([, type, audience, body, ttl, urgency]) => ({ type, audience, body, ttl: Number(ttl), urgency }));

describe("146 push catalogue (lock-screen text)", () => {
  it("has the 20 approved entries", () => { expect(catalog).toHaveLength(20); });
  it("never carries names, places, numbers, times or placeholders", () => {
    for (const c of catalog) {
      expect(c.body, c.type).not.toMatch(/[0-9{}<>@/$%]/);
      expect(c.body.length, c.type).toBeLessThanOrEqual(80);
      expect(c.body, c.type).not.toMatch(/residente|paciente|diagn|calle|avenida|urb\./i);
      expect(c.body, c.type).not.toMatch(/agencia [A-Z]/);
    }
  });
  it("decision 1: incidents never go to families by push", () => {
    expect(catalog.filter((c) => c.type === "NEW_INCIDENT").map((c) => c.audience)).toEqual(["agency"]);
  });
  it("covers the priority events of each portal", () => {
    const has = (aud: string, type: string) => catalog.some((c) => c.audience === aud && c.type === type);
    for (const t of ["SHIFT_ASSIGNMENT_ACCEPTED", "SHIFT_ASSIGNMENT_REJECTED", "SHIFT_STARTED", "SHIFT_DELAY_REPORTED", "SHIFT_LATE_ARRIVAL", "NEW_INCIDENT"]) expect(has("agency", t), t).toBe(true);
    for (const t of ["SHIFT_ASSIGNMENT_PENDING", "SHIFT_RESCHEDULED", "SHIFT_LOCATION_CHANGED", "SHIFT_CANCELLED", "SHIFT_UNASSIGNED"]) expect(has("caregiver", t), t).toBe(true);
    for (const t of ["FAMILY_CAREGIVER_ARRIVED", "SHIFT_STARTED", "FAMILY_VISIT_CANCELLED", "NEW_MESSAGE"]) expect(has("family", t), t).toBe(true);
  });
});

describe("146 payload", () => {
  it("only the fixed text and the opaque link", () => {
    const p = JSON.parse(buildPushPayload({ notification_id: E, title: "ETNARA Care", body: "La cuidadora llegó" }, "https://app.etnaracare.com/"));
    expect(p).toEqual({ web_push: 8030, notification: { title: "ETNARA Care", body: "La cuidadora llegó", navigate: `https://app.etnaracare.com/abrir?n=${E}`, lang: "es-PR", dir: "ltr", silent: false } });
  });
});

describe("146 where a notice opens", () => {
  const t = (type: string, audience: "agency" | "caregiver" | "family" | "self", extra: Partial<{ relatedEntityType: string; relatedEntityId: string; shiftId: string }> = {}) =>
    notificationTargetPath({ type, audience, relatedEntityType: extra.relatedEntityType ?? null, relatedEntityId: extra.relatedEntityId ?? null, shiftId: extra.shiftId ?? null });
  it("agency", () => {
    expect(t("SHIFT_ASSIGNMENT_ACCEPTED", "agency", { shiftId: S })).toBe(`/agency/shifts/${S}`);
    expect(t("NEW_INCIDENT", "agency", { relatedEntityType: "incident", relatedEntityId: E })).toBe(`/agency/incidents/${E}`);
  });
  it("caregiver", () => {
    expect(t("SHIFT_ASSIGNMENT_PENDING", "caregiver", { shiftId: S })).toBe(`/caregiver/shifts/${S}`);
    expect(t("SHIFT_UNASSIGNED", "caregiver", { shiftId: S })).toBe("/caregiver/shifts");
  });
  it("family", () => {
    expect(t("FAMILY_CAREGIVER_ARRIVED", "family", { shiftId: S })).toBe("/family");
    expect(t("NEW_MESSAGE", "family", { relatedEntityType: "message_thread", relatedEntityId: E })).toBe(`/family/messages?thread=${E}`);
  });
  it("never builds a path from anything but a uuid", () => {
    expect(t("SHIFT_CANCELLED", "caregiver", { shiftId: "../../platform" })).toBe("/caregiver/shifts");
    expect(t("NEW_MESSAGE", "family", { relatedEntityType: "message_thread", relatedEntityId: "x?y=1" })).toBe("/family/messages");
    expect(t("PUSH_TEST", "self")).toBeNull();
  });
});
