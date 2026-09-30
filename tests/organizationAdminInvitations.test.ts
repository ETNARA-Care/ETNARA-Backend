import { describe, expect, it, vi } from "vitest";
import {
  sendOrganizationAdminInvitationEmail,
  loadEmailConfig,
  type OrganizationAdminInvitationEmail,
  type EmailConfig,
} from "../src/modules/email/email.service.js";

describe("Organization admin invitations", () => {
  describe("Email service", () => {
    it("sends invitation email via Resend with activation token", async () => {
      const payload: OrganizationAdminInvitationEmail = {
        recipientEmail: "newadmin@example.com",
        organizationName: "Test Organization",
        activationToken:
          "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
        invitedByEmail: "admin@etnara.care",
      };

      const config: EmailConfig = {
        apiKey: "test-api-key-12345",
        senderEmail: "invitations@etnara.care",
        senderName: "ETNARA Care",
        activationBaseUrl: "https://app.etnara.care",
      };

      let capturedAuth = "";
      let capturedBody = "";
      const mockFetch = vi.fn(async (_url: string, opts: any) => {
        capturedAuth = opts.headers?.["Authorization"] || "";
        capturedBody = opts.body || "";
        return new Response(
          JSON.stringify({ id: "msg_test123456789" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

      const originalFetch = global.fetch;
      (global as any).fetch = mockFetch;

      try {
        const result = await sendOrganizationAdminInvitationEmail(payload, config);

        expect(result.status).toBe("sent");
        expect(result.messageId).toBe("msg_test123456789");
        expect(capturedAuth).toBe("Bearer test-api-key-12345");
        
        const body = JSON.parse(capturedBody);
        expect(body.to).toBe("newadmin@example.com");
        expect(body.from).toContain("invitations@etnara.care");
        expect(body.subject).toContain("administrador");
        expect(body.html).toContain("Test Organization");
        expect(body.html).toContain("admin@etnara.care");
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it("returns failed status when API key is not configured", async () => {
      const payload: OrganizationAdminInvitationEmail = {
        recipientEmail: "newadmin@example.com",
        organizationName: "Test Organization",
        activationToken: "token123",
        invitedByEmail: "admin@etnara.care",
      };

      const config: EmailConfig = {
        apiKey: undefined,
        senderEmail: "invitations@etnara.care",
        senderName: "ETNARA Care",
        activationBaseUrl: "https://app.etnara.care",
      };

      const result = await sendOrganizationAdminInvitationEmail(payload, config);

      expect(result.status).toBe("failed");
      expect(result.error).toBe("EMAIL_NOT_CONFIGURED");
      expect(result.messageId).toBeUndefined();
    });

    it("returns failed status on HTTP error from Resend API", async () => {
      const payload: OrganizationAdminInvitationEmail = {
        recipientEmail: "newadmin@example.com",
        organizationName: "Test Organization",
        activationToken: "token123",
        invitedByEmail: "admin@etnara.care",
      };

      const config: EmailConfig = {
        apiKey: "test-key",
        senderEmail: "invitations@etnara.care",
        senderName: "ETNARA Care",
        activationBaseUrl: "https://app.etnara.care",
      };

      const originalFetch = global.fetch;
      (global as any).fetch = vi.fn(async () => {
        return new Response("Unauthorized", { status: 401 });
      });

      try {
        const result = await sendOrganizationAdminInvitationEmail(payload, config);

        expect(result.status).toBe("failed");
        expect(result.error).toContain("HTTP");
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it("handles network errors gracefully", async () => {
      const payload: OrganizationAdminInvitationEmail = {
        recipientEmail: "newadmin@example.com",
        organizationName: "Test Organization",
        activationToken: "token123",
        invitedByEmail: "admin@etnara.care",
      };

      const config: EmailConfig = {
        apiKey: "test-key",
        senderEmail: "invitations@etnara.care",
        senderName: "ETNARA Care",
        activationBaseUrl: "https://app.etnara.care",
      };

      const originalFetch = global.fetch;
      (global as any).fetch = vi.fn(async () => {
        throw new Error("Network timeout");
      });

      try {
        const result = await sendOrganizationAdminInvitationEmail(payload, config);

        expect(result.status).toBe("failed");
        expect(result.error).toContain("Network timeout");
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it("escapes HTML in organization name and inviter email", async () => {
      const payload: OrganizationAdminInvitationEmail = {
        recipientEmail: "newadmin@example.com",
        organizationName: "Test <script>alert('xss')</script> Org",
        activationToken: "token123",
        invitedByEmail: "admin+test@etnara.care",
      };

      const config: EmailConfig = {
        apiKey: "test-key",
        senderEmail: "invitations@etnara.care",
        senderName: "ETNARA Care",
        activationBaseUrl: "https://app.etnara.care",
      };

      let capturedBody = "";
      const originalFetch = global.fetch;
      (global as any).fetch = vi.fn(async (_url: string, opts: any) => {
        capturedBody = opts.body || "";
        return new Response(JSON.stringify({ id: "msg_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        await sendOrganizationAdminInvitationEmail(payload, config);

        const body = JSON.parse(capturedBody);
        expect(body.html).not.toContain("<script>");
        expect(body.html).toContain("&lt;script&gt;");
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it("loads default email configuration from environment", () => {
      const originalEnv = { ...process.env };

      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_SENDER_ADDRESS;
      delete process.env.EMAIL_SENDER_NAME;
      delete process.env.ACTIVATION_BASE_URL;

      try {
        const config = loadEmailConfig();

        expect(config.apiKey).toBeUndefined();
        expect(config.senderEmail).toBe("invitations@etnara.care");
        expect(config.senderName).toBe("ETNARA Care");
        expect(config.activationBaseUrl).toBe("https://app.etnara.care");
      } finally {
        Object.assign(process.env, originalEnv);
      }
    });

    it("loads custom email configuration from environment", () => {
      const originalEnv = { ...process.env };

      process.env.RESEND_API_KEY = "custom-key-123";
      process.env.EMAIL_SENDER_ADDRESS = "custom@example.com";
      process.env.EMAIL_SENDER_NAME = "Custom Sender";
      process.env.ACTIVATION_BASE_URL = "https://custom.example.com";

      try {
        const config = loadEmailConfig();

        expect(config.apiKey).toBe("custom-key-123");
        expect(config.senderEmail).toBe("custom@example.com");
        expect(config.senderName).toBe("Custom Sender");
        expect(config.activationBaseUrl).toBe("https://custom.example.com");
      } finally {
        Object.assign(process.env, originalEnv);
      }
    });
  });

  describe("Security: API key handling", () => {
    it("never logs or exposes the RESEND_API_KEY value", async () => {
      const consoleSpy = vi.spyOn(console, "error");

      const payload: OrganizationAdminInvitationEmail = {
        recipientEmail: "test@example.com",
        organizationName: "Org",
        activationToken: "token",
        invitedByEmail: "admin@etnara.care",
      };

      const config: EmailConfig = {
        apiKey: "super-secret-resend-key-12345",
        senderEmail: "sender@example.com",
        senderName: "Sender",
        activationBaseUrl: "https://example.com",
      };

      const originalFetch = global.fetch;
      (global as any).fetch = vi.fn(async () => {
        throw new Error("Network error");
      });

      try {
        await sendOrganizationAdminInvitationEmail(payload, config);

        const errorCalls = consoleSpy.mock.calls;
        for (const call of errorCalls) {
          const callString = JSON.stringify(call);
          expect(callString).not.toContain("super-secret-resend-key-12345");
        }
      } finally {
        (global as any).fetch = originalFetch;
        consoleSpy.mockRestore();
      }
    });

    it("uses Bearer token in Authorization header", async () => {
      const payload: OrganizationAdminInvitationEmail = {
        recipientEmail: "test@example.com",
        organizationName: "Org",
        activationToken: "token",
        invitedByEmail: "admin@etnara.care",
      };

      const config: EmailConfig = {
        apiKey: "secret-key",
        senderEmail: "sender@example.com",
        senderName: "Sender",
        activationBaseUrl: "https://example.com",
      };

      let capturedAuth = "";
      const originalFetch = global.fetch;
      (global as any).fetch = vi.fn(async (_url: string, opts: any) => {
        capturedAuth = opts.headers?.["Authorization"] || "";
        return new Response(JSON.stringify({ id: "msg_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        await sendOrganizationAdminInvitationEmail(payload, config);

        expect(capturedAuth).toBe("Bearer secret-key");
      } finally {
        (global as any).fetch = originalFetch;
      }
    });
  });
});

