/**
 * Typed errors for the tenant/platform context layer. Kept separate from
 * tenantContext.ts so callers (eventually: the Express error handler) can
 * import and pattern-match on these without pulling in the transaction
 * implementation itself.
 */

export class InvalidTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTenantContextError";
  }
}

export class MembershipNotActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipNotActiveError";
  }
}

export class UnauthorizedPlatformAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedPlatformAccessError";
  }
}
