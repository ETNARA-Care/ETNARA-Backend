import { describe, expect, it } from "vitest";
import { invoiceTotals, priceManual, priceShift, splitAtMidnight, type SegmentRate } from "../src/modules/billing/billingCalc.js";

const rate = (amountCents: number, extra: Partial<SegmentRate> = {}): SegmentRate => ({
  rateId: `r-${amountCents}`, amountCents, source: "general", dayType: "standard", holiday: null,
  minMinutes: null, roundingMinutes: null, halfDayPolicy: null, halfDayAmountCents: null, ...extra,
});

describe("Facturación F2.2 — overnight segments (D8), hand-calculated", () => {
  it("cuts at Puerto Rico midnight and never duplicates minutes", () => {
    const s = splitAtMidnight("2026-12-24T22:00:00-04:00", 480);
    expect(s.map((x) => [x.date, x.minutes])).toEqual([["2026-12-24", 120], ["2026-12-25", 360]]);
    expect(s.reduce((a, x) => a + x.minutes, 0)).toBe(480);
    const long = splitAtMidnight("2026-10-01T20:00:00-04:00", 2880);
    expect(long.map((x) => x.minutes)).toEqual([240, 1440, 1200]);
    expect(splitAtMidnight("2026-10-01T09:00:00-04:00", 480).length).toBe(1);
  });

  it("22:00–06:00 with Christmas as a holiday: 2 h × $25.00 + 6 h × $37.50 = $275.00 (design example)", () => {
    const r = priceShift("hour", "2026-12-24T22:00:00-04:00", 480, (d) => (d === "2026-12-25" ? rate(3750, { dayType: "holiday", holiday: "Navidad" }) : rate(2500)));
    expect(r.amountCents).toBe(27500);
    expect(r.segments.map((s) => s.amountCents)).toEqual([5000, 22500]);
    expect(r.segments[1].rate?.holiday).toBe("Navidad");
    expect(r.quantityHundredths).toBe(800);
    expect(r.unitPriceCents).toBeNull();
  });

  it("rate change at midnight: the second segment uses the new version", () => {
    const r = priceShift("hour", "2026-11-30T22:00:00-04:00", 480, (d) => (d >= "2026-12-01" ? rate(2700) : rate(2500)));
    expect(r.segments.map((s) => s.amountCents)).toEqual([5000, 16200]);
    expect(r.amountCents).toBe(21200);
  });

  it("minimum and rounding are applied once to the whole shift; extra minutes go to the last segment", () => {
    const r = priceShift("hour", "2026-10-01T23:00:00-04:00", 130, () => rate(2500, { minMinutes: 240, roundingMinutes: 30 }));
    expect(r.segments.map((s) => [s.minutes, s.billableMinutes])).toEqual([[60, 60], [70, 180]]);
    expect(r.amountCents).toBe(10000); // 240 min × $25 / 60, a single minimum
    expect(r.quantityHundredths).toBe(400);
  });

  it("splitting never changes the total by a cent (rounding on the sum)", () => {
    const r = priceShift("hour", "2026-10-01T23:30:00-04:00", 60, () => rate(2501));
    expect(r.amountCents).toBe(2501);
    expect(r.segments.map((s) => s.amountCents)).toEqual([1251, 1250]);
  });

  it("shift and fixed units: one charge at the starting segment's rate", () => {
    const r = priceShift("shift", "2026-12-24T22:00:00-04:00", 480, (d) => (d === "2026-12-25" ? rate(30000) : rate(20000)));
    expect(r.amountCents).toBe(20000);
    expect(r.segments.map((s) => s.amountCents)).toEqual([20000, 0]);
  });

  it("day unit: 23 h 50 min stays a partial day for review, tolerance only warns", () => {
    const r = priceShift("day", "2026-10-01T08:00:00-04:00", 1430, () => rate(18000));
    expect(r.amountCents).toBe(0);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons).toContain("PARTIAL_DAY");
    expect(r.warnings).toEqual([{ code: "DAY_ALMOST_COMPLETE", minutes: 10 }]);
  });

  it("day unit: 1 day + 12 h with a fixed half day = $180 + $90", () => {
    const r = priceShift("day", "2026-10-01T08:00:00-04:00", 2160, () => rate(18000, { halfDayPolicy: "fixed", halfDayAmountCents: 9000 }));
    expect(r.amountCents).toBe(27000);
    expect(r.quantityHundredths).toBe(150);
    expect(r.warnings).toEqual([]);
  });

  it("a missing rate on any segment flags the line instead of guessing", () => {
    const r = priceShift("hour", "2026-12-24T22:00:00-04:00", 480, (d) => (d === "2026-12-25" ? null : rate(2500)));
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons).toEqual(["NO_BILLING_RATE"]);
    expect(r.amountCents).toBe(0);
  });
});

describe("Facturación F2.2 — manual lines and totals", () => {
  it("manual: quantity × price, half up", () => {
    expect(priceManual(150, 2499)).toBe(3749); // 37.485 → 37.49
    expect(() => priceManual(0, 100)).toThrow();
  });

  it("tax per rate group after discounts; exempt and pending carry no tax; nothing assumed", () => {
    const t = invoiceTotals([
      { amountCents: 10000, taxTreatment: "taxable", taxRateBasisPoints: 1150 },
      { amountCents: -1000, taxTreatment: "taxable", taxRateBasisPoints: 1150 },
      { amountCents: 5000, taxTreatment: "exempt", taxRateBasisPoints: null },
    ]);
    expect(t.subtotalCents).toBe(14000);
    expect(t.taxes).toEqual([{ rateBasisPoints: 1150, baseCents: 9000, taxCents: 1035, negativeBase: false }]);
    expect(t.totalCents).toBe(15035);
    expect(t.taxPending).toBe(false);
    const p = invoiceTotals([{ amountCents: 2000, taxTreatment: "pending", taxRateBasisPoints: null }]);
    expect(p.taxPending).toBe(true);
    expect(p.taxCents).toBe(0);
  });
});
