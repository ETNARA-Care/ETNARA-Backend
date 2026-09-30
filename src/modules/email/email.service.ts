/**
 * Transactional email delivery via Resend.
 * Uses RESEND_API_KEY for authentication without exposing the key value.
 * Configuration variables control sender and base URL; email provider
 * failures do not corrupt invitation state (email is best-effort).
 */

export interface EmailDeliveryResult {
  status: "sent" | "failed";
  messageId?: string;
  error?: string;
}

export interface OrganizationAdminInvitationEmail {
  recipientEmail: string;
  organizationName: string;
  activationToken: string;
  invitedByEmail: string;
}

export interface EmailConfig {
  apiKey: string | undefined;
  senderEmail: string;
  senderName: string;
  activationBaseUrl: string;
}

export function loadEmailConfig(): EmailConfig {
  const apiKey = process.env.RESEND_API_KEY;
  const senderEmail = process.env.EMAIL_SENDER_ADDRESS || "invitations@etnara.care";
  const senderName = process.env.EMAIL_SENDER_NAME || "ETNARA Care";
  const activationBaseUrl = process.env.ACTIVATION_BASE_URL || "https://app.etnara.care";

  return { apiKey, senderEmail, senderName, activationBaseUrl };
}

export async function sendOrganizationAdminInvitationEmail(
  payload: OrganizationAdminInvitationEmail,
  config: EmailConfig
): Promise<EmailDeliveryResult> {
  if (!config.apiKey) {
    console.warn(
      "RESEND_API_KEY not configured; organization admin invitation email skipped"
    );
    return {
      status: "failed",
      error: "EMAIL_NOT_CONFIGURED",
    };
  }

  const activationLink = `${config.activationBaseUrl}/invite/organization-admin?token=${encodeURIComponent(payload.activationToken)}`;

  const htmlContent = `
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333;">
    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1>${config.senderName}</h1>
      <p>Hola,</p>
      <p>Has sido invitado a administrar una organización en ${config.senderName}.</p>
      <p><strong>Organización:</strong> ${escapeHtml(payload.organizationName)}</p>
      <p><strong>Invitado por:</strong> ${escapeHtml(payload.invitedByEmail)}</p>
      <p>Este token de invitación expira en 7 días.</p>
      <p>
        <a href="${escapeHtml(activationLink)}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px;">
          Aceptar invitación
        </a>
      </p>
      <p>Si el botón anterior no funciona, copia y pega este enlace en tu navegador:</p>
      <p><code>${escapeHtml(activationLink)}</code></p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="font-size: 12px; color: #999;">
        Si no esperabas esta invitación, puedes ignorar este correo de forma segura.
      </p>
    </div>
  </body>
</html>
`.trim();

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${config.senderName} <${config.senderEmail}>`,
        to: payload.recipientEmail,
        subject: `Invitación de administrador en ${config.senderName}`,
        html: htmlContent,
      }),
    });

    if (!response.ok) {
      console.error("Resend API error", { status: response.status });
      return {
        status: "failed",
        error: `HTTP ${response.status}`,
      };
    }

    const result = await response.json() as { id?: string };
    if (!result.id) {
      console.error("Resend response missing message id");
      return {
        status: "failed",
        error: "INVALID_RESPONSE",
      };
    }

    return {
      status: "sent",
      messageId: result.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Email delivery failed", { message });
    return {
      status: "failed",
      error: message,
    };
  }
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (c) => map[c] || c);
}

