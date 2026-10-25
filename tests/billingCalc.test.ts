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

import { allocateApproved, priceAllocated } from "../src/modules/billing/billingCalc.js";

const xmas = (d: string) => (d === "2026-12-25" ? rate(3750, { dayType: "holiday", holiday: "Navidad" }) : rate(2500));
const period = (checkInIso: string, checkOutIso: string, approvedMinutes: number, timesheetId: string | null = null) => ({ timesheetId, checkInIso, checkOutIso, approvedMinutes });

describe("Facturación D1 (opción C): minutos aprobados repartidos en proporción al tiempo real", () => {
  it("22:00–06:30 real (510 min), 480 aprobados, Navidad: 113 + 367 min = $276.46 (ejemplo de la revisión)", () => {
    const a = allocateApproved([period("2026-12-24T22:00:00-04:00", "2026-12-25T06:30:00-04:00", 480)]);
    expect(a.exception).toBeNull();
    expect(a.segments.map((s) => [s.date, s.minutes, s.realMs / 60000])).toEqual([["2026-12-24", 113, 120], ["2026-12-25", 367, 390]]);
    const r = priceAllocated("hour", a.segments, xmas);
    // 113 × 25.00 / 60 + 367 × 37.50 / 60 = 47.0833 + 229.375 = 276.4583 → $276.46 (rounded once, on the sum)
    expect(r.amountCents).toBe(27646);
    expect(r.segments.map((s) => s.amountCents)).toEqual([4708, 22938]);
    expect(r.segments.reduce((sum, s) => sum + s.minutes, 0)).toBe(480);
    expect(r.quantityHundredths).toBe(800);
  });

  it("si lo aprobado coincide con lo real, C da lo mismo que antes: $275.00", () => {
    const a = allocateApproved([period("2026-12-24T22:00:00-04:00", "2026-12-25T06:00:00-04:00", 480)]);
    expect(a.segments.map((s) => s.minutes)).toEqual([120, 360]);
    expect(priceAllocated("hour", a.segments, xmas).amountCents).toBe(27500);
  });

  it("cambio de tarifa a medianoche: 23:00–03:00 real, 180 aprobados → 45 min a $25 + 135 min a $27 = $79.50", () => {
    const a = allocateApproved([period("2026-11-30T23:00:00-04:00", "2026-12-01T03:00:00-04:00", 180)]);
    expect(a.segments.map((s) => s.minutes)).toEqual([45, 135]);
    const r = priceAllocated("hour", a.segments, (d) => (d >= "2026-12-01" ? rate(2700) : rate(2500)));
    expect(r.amountCents).toBe(1875 + 6075);
  });

  it("nunca inventa horas: si se aprobó MÁS que el tiempo real, exige revisión manual", () => {
    expect(allocateApproved([period("2026-10-01T09:00:00-04:00", "2026-10-01T13:00:00-04:00", 241)]).exception).toBe("APPROVED_EXCEEDS_RECORDED");
    expect(allocateApproved([period("2026-10-01T09:00:00-04:00", "2026-10-01T13:00:00-04:00", 240)]).exception).toBeNull();
    expect(allocateApproved([period("2026-10-01T09:00:00-04:00", "2026-10-01T08:00:00-04:00", 60)]).exception).toBe("REAL_TIMES_MISSING");
    expect(allocateApproved([]).exception).toBe("HOURS_NOT_APPROVED");
  });

  it("un tramo real de segundos puede quedar con 0 minutos aprobados; se conserva para la traza y no cobra", () => {
    const a = allocateApproved([period("2026-10-01T23:59:30-04:00", "2026-10-02T08:00:00-04:00", 300)]);
    expect(a.segments.map((s) => [s.date, s.minutes])).toEqual([["2026-10-01", 0], ["2026-10-02", 300]]);
    const r = priceAllocated("hour", a.segments, () => rate(2500));
    expect(r.amountCents).toBe(12500);
    expect(r.segments[0].amountCents).toBe(0);
  });

  it("propiedad (2,000 casos): la suma es exactamente lo aprobado, ningún tramo supera su tiempo real y el total cuadra al centavo", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const start = Date.parse("2026-10-01T00:00:00-04:00") + rnd(60 * 24 * 30) * 60000 + rnd(60) * 1000;
      const realMin = 1 + rnd(2879);
      const approved = 1 + rnd(realMin);
      const a = allocateApproved([period(new Date(start).toISOString(), new Date(start + realMin * 60000).toISOString(), approved)]);
      expect(a.exception).toBeNull();
      expect(a.segments.reduce((s, x) => s + x.minutes, 0)).toBe(approved);
      for (const s of a.segments) { expect(s.minutes).toBeGreaterThanOrEqual(0); expect(s.minutes).toBeLessThanOrEqual(Math.ceil(s.realMs / 60000)); }
      const r = priceAllocated("hour", a.segments, (d) => rate(d.endsWith("5") ? 3750 : 2500));
      expect(r.segments.reduce((s, x) => s + x.amountCents, 0)).toBe(r.amountCents);
      const exact = a.segments.reduce((s, x) => s + x.minutes * (x.date.endsWith("5") ? 3750 : 2500), 0) / 60;
      expect(Math.abs(r.amountCents - exact)).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("Facturación D2: mínimo y redondeo de la tarifa vigente al comienzo del turno, una sola vez", () => {
  it("23:00–01:00 real, 90 aprobados (45 + 45), mínimo del día 1 = 4 h, del día 2 = 3 h → 240 min, un solo mínimo", () => {
    const a = allocateApproved([period("2026-10-01T23:00:00-04:00", "2026-10-02T01:00:00-04:00", 90)]);
    const r = priceAllocated("hour", a.segments, (d) => (d === "2026-10-01" ? rate(2500, { minMinutes: 240 }) : rate(2500, { minMinutes: 180 })));
    expect(r.segments.map((s) => [s.minutes, s.billableMinutes])).toEqual([[45, 45], [45, 195]]);
    expect(r.amountCents).toBe(10000);
  });

  it("el redondeo también sale de la tarifa de inicio (30 min) aunque la siguiente diga 60", () => {
    const a = allocateApproved([period("2026-10-01T23:00:00-04:00", "2026-10-02T00:40:00-04:00", 100)]);
    const r = priceAllocated("hour", a.segments, (d) => (d === "2026-10-01" ? rate(2400, { roundingMinutes: 30 }) : rate(2400, { roundingMinutes: 60 })));
    expect(r.segments.reduce((s, x) => s + x.billableMinutes, 0)).toBe(120);
    expect(r.amountCents).toBe(4800);
  });
});

describe("Facturación D4 (opción B): varias hojas de horas que no se solapan se suman", () => {
  it("reasignación a medianoche: 20:00–00:00 (240 aprobados) + 00:00–04:00 (200 de 240), Navidad → $100.00 + $125.00", () => {
    const a = allocateApproved([
      period("2026-12-25T00:00:00-04:00", "2026-12-25T04:00:00-04:00", 200, "ts-b"),
      period("2026-12-24T20:00:00-04:00", "2026-12-25T00:00:00-04:00", 240, "ts-a"),
    ]);
    expect(a.exception).toBeNull();
    expect(a.segments.map((s) => [s.timesheetId, s.date, s.minutes])).toEqual([["ts-a", "2026-12-24", 240], ["ts-b", "2026-12-25", 200]]);
    const r = priceAllocated("hour", a.segments, xmas);
    expect(r.amountCents).toBe(22500);
    expect(r.quantityHundredths).toBe(Math.round((440 * 100) / 60));
    expect(r.segments.map((s) => s.timesheetId)).toEqual(["ts-a", "ts-b"]);
  });

  it("el mínimo se aplica una vez al turno completo, no por hoja", () => {
    const a = allocateApproved([period("2026-10-01T08:00:00-04:00", "2026-10-01T09:00:00-04:00", 60, "a"), period("2026-10-01T10:00:00-04:00", "2026-10-01T11:00:00-04:00", 60, "b")]);
    const r = priceAllocated("hour", a.segments, () => rate(2500, { minMinutes: 180 }));
    expect(r.segments.map((s) => s.billableMinutes)).toEqual([60, 120]);
    expect(r.amountCents).toBe(7500);
  });

  it("períodos que se solapan o duplicados se rechazan; uno que empieza justo al terminar el otro se acepta", () => {
    const a = period("2026-10-01T08:00:00-04:00", "2026-10-01T12:00:00-04:00", 240, "a");
    expect(allocateApproved([a, period("2026-10-01T11:59:00-04:00", "2026-10-01T16:00:00-04:00", 240, "b")]).exception).toBe("TIMESHEETS_OVERLAP");
    expect(allocateApproved([a, { ...a, timesheetId: "dup" }]).exception).toBe("TIMESHEETS_OVERLAP");
    expect(allocateApproved([a, period("2026-10-01T12:00:00-04:00", "2026-10-01T16:00:00-04:00", 240, "b")]).exception).toBeNull();
  });

  it("unidad día con dos hojas: 24 h aprobadas en total = 1 día al precio del día en que empieza", () => {
    const a = allocateApproved([period("2026-10-01T08:00:00-04:00", "2026-10-01T20:00:00-04:00", 720, "a"), period("2026-10-01T20:00:00-04:00", "2026-10-02T08:00:00-04:00", 720, "b")]);
    const r = priceAllocated("day", a.segments, () => rate(18000));
    expect(r.amountCents).toBe(18000);
    expect(r.quantityHundredths).toBe(100);
    expect(r.needsReview).toBe(false);
  });
});
