import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

/**
 * Safe logging of unexpected (500) errors.
 *
 * Each 500 gets a random errorId that is returned to the client and written to
 * the log, so a report from the app ("código de error …") leads to the exact
 * log line. The log line never carries personal data:
 *   - the route TEMPLATE ("/organizations/:organizationId/shifts/:shiftId/check-out"),
 *     never the actual path, ids, query, headers or body;
 *   - for PostgreSQL errors only the SQLSTATE code, constraint, table and routine
 *     names and a sanitized message (quoted values, uuids, e-mails and long
 *     numbers removed); never `detail`, `where` or `hint`, which can hold row values.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function sanitizeErrorMessage(message: unknown): string {
  if (typeof message !== "string") return "";
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\([^)]*\)=\([^)]*\)/g, "(…)=(…)")
    .replace(UUID, "<uuid>")
    .replace(/[^\s@]+@[^\s@]+/g, "<email>")
    .replace(/\d{4,}/g, "<n>")
    .slice(0, 160);
}

interface PgLikeError {
  name?: unknown;
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  routine?: unknown;
  message?: unknown;
}

const str = (v: unknown, max = 80) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);

export function describeInternalError(scope: string, err: unknown, req?: Pick<Request, "method" | "route" | "baseUrl">) {
  const e = (err && typeof err === "object" ? err : {}) as PgLikeError;
  const routePath = req?.route && typeof (req.route as { path?: unknown }).path === "string" ? (req.route as { path: string }).path : undefined;
  return {
    event: "INTERNAL_ERROR",
    scope,
    method: req?.method,
    route: routePath ? `${req?.baseUrl ?? ""}${routePath}` : undefined,
    name: str(e.name, 60) ?? (err instanceof Error ? err.name : typeof err),
    code: str(e.code, 10),
    constraint: str(e.constraint),
    table: str(e.table),
    routine: str(e.routine),
    message: sanitizeErrorMessage(e.message),
  };
}

/** Logs the error safely and returns its reference id. */
export function logInternalError(scope: string, err: unknown, req?: Pick<Request, "method" | "route" | "baseUrl">): string {
  const errorId = randomUUID();
  console.error(JSON.stringify({ errorId, ...describeInternalError(scope, err, req) }));
  return errorId;
}

/** 500 with a reference id only: no internal detail reaches the client. */
export function respondInternalError(res: Response, scope: string, err: unknown, req?: Request): void {
  const errorId = logInternalError(scope, err, req);
  if (!res.headersSent) res.status(500).json({ error: "INTERNAL_ERROR", errorId });
}
