import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFamilyInvitationEmail, familyInvitationLink, sendFamilyInvitationEmail } from "../src/modules/email/familyInvitationEmail.js";
import type { EmailConfig } from "../src/modules/email/email.service.js";

const config: EmailConfig = { apiKey: "test-only", senderEmail: "no-reply@example.invalid", senderName: "ETNARA Care", activationBaseUrl: "https://app.example.invalid/" };
const token = "a".repeat(64);
const payload = { recipientEmail: "familia@example.invalid", organizationName: "Agencia Sol", activationToken: token, expiresAt: "2026-11-01T03:30:00.000Z" };

describe("family invitation e-mail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("links to /activate with the token in the URL fragment (never sent to a server)", () => {
    expect(familyInvitationLink(config, token)).toBe(`https://app.example.invalid/activate#token=${token}`);
  });

  it("names the agency, has a call to action, the expiry in Puerto Rico time and a plain-text part", () => {
    const { subject, html, text } = buildFamilyInvitationEmail(payload, config);
    expect(subject).toBe("Agencia Sol te invita al Portal Familiar de ETNARA Care");
    expect(html).toContain("Activar mi acceso");
    expect(html).toContain(`/activate#token=${token}`);
    expect(text).toContain(`/activate#token=${token}`);
    expect(text).toContain("31 de octubre de 2026"); // 03:30 UTC on 1-Nov is 23:30 on 31-Oct in Puerto Rico
    expect(text).toMatch(/un solo uso/);
  });

  it("escapes the agency name in the HTML", () => {
    const { html } = buildFamilyInvitationEmail({ ...payload, organizationName: `<img src=x onerror=alert(1)> & "Co"` }, config);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;");
  });

  it("carries no resident data, password or permanent code (the payload has no such field)", () => {
    const { html, text } = buildFamilyInvitationEmail(payload, config);
    expect(Object.keys(payload).sort()).toEqual(["activationToken", "expiresAt", "organizationName", "recipientEmail"]);
    expect(text).not.toMatch(/contraseña:\s*\S/i);
    expect(html).not.toContain("familia@example.invalid");
  });

  it("is 'sent' only when the provider answers 2xx with a message id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    await expect(sendFamilyInvitationEmail(payload, config)).resolves.toEqual({ status: "sent", messageId: "msg_1" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 }));
    await expect(sendFamilyInvitationEmail(payload, config)).resolves.toEqual({ status: "failed", error: "HTTP 403" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(sendFamilyInvitationEmail(payload, config)).resolves.toEqual({ status: "failed", error: "INVALID_RESPONSE" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(sendFamilyInvitationEmail(payload, config)).resolves.toEqual({ status: "failed", error: "TypeError" });
    await expect(sendFamilyInvitationEmail(payload, { ...config, apiKey: undefined })).resolves.toEqual({ status: "failed", error: "EMAIL_NOT_CONFIGURED" });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ from: "ETNARA Care <no-reply@example.invalid>", to: "familia@example.invalid" });
    expect(typeof body.text).toBe("string");
  });
});
