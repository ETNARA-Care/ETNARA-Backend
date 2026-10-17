import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { checkLimit, recordAttempt, cleanupExpired, resetLimitsForTests, rateLimitKeyCountForTests } from "../src/modules/auth/auth.rateLimit.js";

function request(ip: string): Request { return { ip } as Request; }
function response() {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: unknown;
  const res = {
    setHeader(k: string, v: string) { headers[k] = v; return this; },
    status(n: number) { status = n; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  return { res, headers, get status() { return status; }, get body() { return body; } };
}
beforeEach(() => { resetLimitsForTests(); vi.useRealTimers(); });
describe("auth rate limiting", () => {
  it("returns 429, generic error and positive Retry-After on sixth email attempt", () => {
    const req = request("10.0.0.1");
    for (let i = 0; i < 5; i++) {
      expect(checkLimit(req, response().res, "a@example.com")).toBe(true);
      recordAttempt(req, "a@example.com");
    }
    const r = response();
    expect(checkLimit(req, r.res, "a@example.com")).toBe(false);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "TOO_MANY_ATTEMPTS" });
    expect(Number(r.headers["Retry-After"])).toBeGreaterThan(0);
  });
  it("successful login clears the email failures", () => {
    const req = request("10.0.0.2");
    for (let i = 0; i < 5; i++) recordAttempt(req, "a@example.com");
    recordAttempt(req, "a@example.com", false);
    expect(checkLimit(req, response().res, "a@example.com")).toBe(true);
  });
  it("blocks after 50 failures from the same IP", () => {
    const req = request("10.0.0.3");
    for (let i = 0; i < 50; i++) {
      expect(checkLimit(req, response().res, `person${i}@example.com`)).toBe(true);
      recordAttempt(req, `person${i}@example.com`);
    }
    const r = response();
    expect(checkLimit(req, r.res, "another@example.com")).toBe(false);
    expect(r.status).toBe(429);
  });
  it("allows 25 successful logins from one IP", () => {
    const req = request("10.0.0.4");
    for (let i = 0; i < 25; i++) {
      expect(checkLimit(req, response().res, "a@example.com")).toBe(true);
      recordAttempt(req, "a@example.com", false);
    }
  });
  it("uses identical 429 for existing and unknown identifiers", () => {
    const output = (ip: string, email: string) => {
      const req = request(ip);
      for (let i = 0; i < 5; i++) recordAttempt(req, email);
      const r = response();
      checkLimit(req, r.res, email);
      return { status: r.status, body: r.body, retryAfter: r.headers["Retry-After"] };
    };
    expect(output("10.0.0.5", "existing@example.com")).toEqual(output("10.0.0.6", "unknown@example.com"));
  });
  it("cleans up expired keys", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordAttempt(request("10.0.0.7"), "a@example.com");
    expect(rateLimitKeyCountForTests()).toBe(2);
    vi.advanceTimersByTime(16 * 60 * 1000);
    cleanupExpired();
    expect(rateLimitKeyCountForTests()).toBe(0);
    vi.useRealTimers();
  });
});
