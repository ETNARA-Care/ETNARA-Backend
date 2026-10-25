import { describe, expect, it } from "vitest";
import { computeCharge, grossMargin, parseDollarsToCents, roundDiv } from "../src/modules/finance/financeCalc.js";

describe("Finanzas F1 — integer money calculation", () => {
  it("rounds half up to the cent with integers only", () => {
    expect(roundDiv(0, 60)).toBe(0);
    expect(roundDiv(29, 60)).toBe(0);
    expect(roundDiv(30, 60)).toBe(1);
    expect(roundDiv(89, 60)).toBe(1);
    expect(roundDiv(90, 60)).toBe(2);
    expect(() => roundDiv(-1, 60)).toThrow();
    expect(() => roundDiv(1.5, 60)).toThrow();
  });

  it("charges hourly services by the minute", () => {
    const rate = { amountCents: 2500 };
    expect(computeCharge("hour", 0, rate).amountCents).toBe(0);
    expect(computeCharge("hour", 1, rate).amountCents).toBe(42); // 2500/60 = 41.67
    expect(computeCharge("hour", 59, rate).amountCents).toBe(2458); // 2458.33
    expect(computeCharge("hour", 60, rate)).toMatchObject({ amountCents: 2500, quantityHundredths: 100 });
    expect(computeCharge("hour", 61, rate).amountCents).toBe(2542); // 2541.67
    expect(computeCharge("hour", 480, rate)).toMatchObject({ amountCents: 20000, quantityHundredths: 800 });
    // 8 h hospital shift crossing midnight is still 480 minutes.
    expect(computeCharge("hour", 480, { amountCents: 3000 }).amountCents).toBe(24000);
  });

  it("applies the hourly minimum, then the rounding increment", () => {
    const rules = { amountCents: 2000, minMinutes: 120, roundingMinutes: 15 };
    expect(computeCharge("hour", 45, rules)).toMatchObject({ amountCents: 4000, quantityHundredths: 200 });
    expect(computeCharge("hour", 119, rules).amountCents).toBe(4000);
    expect(computeCharge("hour", 121, rules)).toMatchObject({ amountCents: 4500, quantityHundredths: 225 }); // 135 min
    expect(computeCharge("hour", 135, rules).amountCents).toBe(4500);
  });

  it("charges shift and fixed-price services once, whatever the length", () => {
    expect(computeCharge("shift", 30, { amountCents: 12000 })).toMatchObject({ amountCents: 12000, quantityHundredths: 100, needsReview: false });
    expect(computeCharge("shift", 900, { amountCents: 12000 }).amountCents).toBe(12000);
    expect(computeCharge("fixed", 75, { amountCents: 6000 }).amountCents).toBe(6000);
  });

  it("treats a 24 h service as one day, never as 24 billable hours", () => {
    expect(computeCharge("day", 1440, { amountCents: 30000 })).toMatchObject({ amountCents: 30000, quantityHundredths: 100, needsReview: false });
    expect(computeCharge("day", 2880, { amountCents: 30000 }).amountCents).toBe(60000);
  });

  it("leaves partial days to the agency unless a half-day rule is configured", () => {
    const review = computeCharge("day", 1080, { amountCents: 30000 }); // 18 h
    expect(review).toMatchObject({ needsReview: true, reviewReason: "PARTIAL_DAY", amountCents: 0 });
    const plusPartial = computeCharge("day", 1440 + 360, { amountCents: 30000 });
    expect(plusPartial).toMatchObject({ needsReview: true, amountCents: 30000 });

    const proportional = computeCharge("day", 1080, { amountCents: 30000, halfDayPolicy: "proportional" });
    expect(proportional).toMatchObject({ needsReview: false, amountCents: 22500, quantityHundredths: 75 });

    const half = computeCharge("day", 720, { amountCents: 30000, halfDayPolicy: "fixed", halfDayAmountCents: 16000 });
    expect(half).toMatchObject({ needsReview: false, amountCents: 16000, quantityHundredths: 50 });
    const dayAndHalf = computeCharge("day", 1440 + 600, { amountCents: 30000, halfDayPolicy: "fixed", halfDayAmountCents: 16000 });
    expect(dayAndHalf.amountCents).toBe(46000);
    // Longer than half a day with a fixed half-day rule: the agency decides.
    expect(computeCharge("day", 900, { amountCents: 30000, halfDayPolicy: "fixed", halfDayAmountCents: 16000 }).needsReview).toBe(true);
  });

  it("estimates gross margin without calling it profit", () => {
    expect(grossMargin(3000, 1800)).toEqual({ differenceCents: 1200, marginBasisPoints: 4000, negative: false });
    expect(grossMargin(2500, 1500)).toEqual({ differenceCents: 1000, marginBasisPoints: 4000, negative: false });
    expect(grossMargin(2800, 1700)).toEqual({ differenceCents: 1100, marginBasisPoints: 3929, negative: false });
    expect(grossMargin(1000, 1200)).toEqual({ differenceCents: -200, marginBasisPoints: -2000, negative: true });
    expect(grossMargin(0, 1500).marginBasisPoints).toBeNull();
  });

  it("flags a negative gross margin (F1.1) without hiding it, and never an even one", () => {
    expect(grossMargin(1500, 1700)).toEqual({ differenceCents: -200, marginBasisPoints: -1333, negative: true });
    expect(grossMargin(0, 1700)).toEqual({ differenceCents: -1700, marginBasisPoints: null, negative: true });
    expect(grossMargin(1700, 1700)).toEqual({ differenceCents: 0, marginBasisPoints: 0, negative: false });
    expect(grossMargin(0, 0)).toEqual({ differenceCents: 0, marginBasisPoints: null, negative: false });
  });

  it("parses dollar text into cents without floats", () => {
    expect(parseDollarsToCents("25")).toBe(2500);
    expect(parseDollarsToCents("25.5")).toBe(2550);
    expect(parseDollarsToCents("$1,025.05")).toBe(102505);
    expect(parseDollarsToCents("0.1")).toBe(10);
    expect(() => parseDollarsToCents("25.555")).toThrow();
    expect(() => parseDollarsToCents("-3")).toThrow();
    expect(() => parseDollarsToCents("abc")).toThrow();
  });

  it("keeps large amounts exact", () => {
    expect(computeCharge("hour", 2880, { amountCents: 100000 }).amountCents).toBe(4800000);
    expect(computeCharge("day", 1440 * 30, { amountCents: 1000000 }).amountCents).toBe(30000000);
  });
});
