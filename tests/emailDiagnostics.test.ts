import { afterEach, describe, expect, it, vi } from "vitest";
import { emailConfigSummary, sendOrganizationAdminInvitationEmail, sendPasswordResetEmail } from "../src/modules/email/email.service.js";

const config = { apiKey: "re_test_not_a_real_key", senderEmail: "no-reply@etnaracare.com", senderName: "ETNARA Care", activationBaseUrl: "https://app.etnaracare.com" };
const refuse = (body: unknown, status = 403) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));

afterEach(() => vi.restoreAllMocks());

describe("Resend failures keep the provider's reason, never an address or the key", () => {
  it("password reset: unverified domain", async () => {
    refuse({ statusCode: 403, name: "validation_error", message: "The etnara.care domain is not verified. Please, add and verify your domain on https://resend.com/domains" });
    const r = await sendPasswordResetEmail("persona@example.com", "a".repeat(64), config);
    expect(r).toEqual({ status: "failed", error: expect.stringMatching(/^HTTP 403 validation_error: The etnara\.care domain is not verified/) });
  });

  it("invitation: testing-mode refusal names the owner's address — removed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    refuse({ name: "validation_error", message: "You can only send testing emails to your own email address (dueno@gmail.com)." });
    const r = await sendOrganizationAdminInvitationEmail({ recipientEmail: "invitada@example.com", organizationName: "Agencia", activationToken: "t", invitedByEmail: "x@example.com" }, config);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("only send testing emails to your own email address (<email>)");
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("validation_error");
    for (const secret of ["dueno@gmail.com", "invitada@example.com", config.apiKey]) expect(logged + (r.error ?? "")).not.toContain(secret);
  });

  it("no JSON body: status only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad gateway", { status: 502 }));
    expect((await sendPasswordResetEmail("p@example.com", "a".repeat(64), config)).error).toBe("HTTP 502");
  });
});

describe("boot summary", () => {
  it("shows the sending domain and link host only", () => {
    const s = emailConfigSummary(config);
    expect(s).toMatchObject({ configured: true, senderDomain: "etnaracare.com", linkHost: "app.etnaracare.com" });
    expect(JSON.stringify(s)).not.toContain(config.apiKey);
    expect(JSON.stringify(s)).not.toContain("no-reply@");
  });
});
