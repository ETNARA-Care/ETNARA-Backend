/**
 * Family portal invitation e-mail (Resend).
 *
 * Kept in its own file so the password-reset and staff-invitation e-mails are
 * untouched. Same provider, same configuration (loadEmailConfig).
 *
 * Privacy: the e-mail names the agency only — never the resident, the inviting
 * administrator or any care detail — so a mistyped address reveals as little as
 * possible. The link carries the one-time token in the URL fragment (#token=…),
 * which browsers never send to a server, so it stays out of access logs and
 * Referer headers. No password or permanent code is ever e-mailed.
 */
import type { EmailConfig, EmailDeliveryResult } from "./email.service.js";

export interface FamilyInvitationEmail {
  recipientEmail: string;
  organizationName: string;
  activationToken: string;
  expiresAt: string;
}

const NAVY = "#16213D";
const NAVY_DEEP = "#0F1830";
const CREAM = "#FBF8F2";
const IVORY = "#F6F0E4";
const SAGE = "#9AB88D";
const MUTED = "#5B6478";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function familyInvitationLink(config: EmailConfig, token: string): string {
  return `${config.activationBaseUrl.replace(/\/+$/, "")}/activate#token=${encodeURIComponent(token)}`;
}

/** «31 de octubre de 2026, 11:28 p. m.» in Puerto Rico time. */
function expiryText(expiresAt: string): string {
  return new Date(expiresAt).toLocaleString("es-PR", { timeZone: "America/Puerto_Rico", dateStyle: "long", timeStyle: "short" });
}

export function buildFamilyInvitationEmail(payload: FamilyInvitationEmail, config: EmailConfig) {
  const link = familyInvitationLink(config, payload.activationToken);
  const org = escapeHtml(payload.organizationName);
  const brand = escapeHtml(config.senderName);
  const expiry = escapeHtml(expiryText(payload.expiresAt));
  const subject = `${payload.organizationName} te invita al Portal Familiar de ${config.senderName}`;
  const preheader = "Activa tu acceso para seguir el cuidado de tu familiar. El enlace es personal y vence en 7 días.";

  // Table layout and inline styles: the format every mail app (Mail on iPhone, Gmail, Outlook) renders the same.
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${IVORY};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${IVORY};">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${IVORY};">
<tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
  <tr><td style="padding:0 6px 18px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;background:${NAVY};border-radius:10px;color:${CREAM};font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:40px;">E</td>
      <td style="padding-left:12px;font-family:Georgia,'Times New Roman',serif;font-size:20px;color:${NAVY};letter-spacing:.2px;">${brand}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#FFFFFF;border-radius:18px;border:1px solid #E7DECB;overflow:hidden;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="background:${NAVY};padding:26px 28px 24px;">
        <p style="margin:0 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:${SAGE};">Portal Familiar</p>
        <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:26px;line-height:1.25;color:${CREAM};">Tienes una invitación de ${org}</h1>
      </td></tr>
      <tr><td style="height:4px;background:${SAGE};font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:26px 28px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:1.6;color:${NAVY_DEEP};">
        <p style="margin:0 0 14px;">Hola:</p>
        <p style="margin:0 0 14px;"><strong>${org}</strong> te invitó al Portal Familiar de ${brand}, donde podrás seguir el cuidado de tu familiar: actividades del día, visitas y mensajes con el equipo.</p>
        <p style="margin:0 0 22px;">Para entrar, activa tu acceso con el botón. Si es tu primera vez, crearás tu propia contraseña; nadie más la conoce.</p>
      </td></tr>
      <tr><td align="center" style="padding:0 28px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" bgcolor="${NAVY}" style="border-radius:12px;">
            <a href="${escapeHtml(link)}" target="_blank" rel="noopener" style="display:inline-block;padding:15px 30px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;font-weight:600;color:${CREAM};text-decoration:none;border-radius:12px;">Activar mi acceso</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:22px 28px 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.55;color:${MUTED};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM};border-radius:12px;"><tr><td style="padding:14px 16px;">
          <p style="margin:0 0 6px;"><strong style="color:${NAVY};">Enlace personal y de un solo uso.</strong> Vence el ${expiry} (hora de Puerto Rico). No lo reenvíes.</p>
          <p style="margin:0;">Si vence o no funciona, pide a ${org} que te envíe uno nuevo.</p>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:16px 28px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:1.55;color:${MUTED};">
        <p style="margin:0 0 6px;">Si el botón no abre, copia y pega este enlace en Safari u otro navegador:</p>
        <p style="margin:0;word-break:break-all;"><a href="${escapeHtml(link)}" style="color:${NAVY};">${escapeHtml(link)}</a></p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:18px 10px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;line-height:1.55;color:${MUTED};text-align:center;">
    <p style="margin:0 0 4px;">¿No esperabas esta invitación? Puedes ignorar este correo: sin activar el enlace no se crea ningún acceso.</p>
    <p style="margin:0;">${brand} nunca te pedirá tu contraseña por correo.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    `${payload.organizationName} te invitó al Portal Familiar de ${config.senderName}.`,
    "",
    "Allí podrás seguir el cuidado de tu familiar: actividades del día, visitas y mensajes con el equipo.",
    "Para entrar, abre este enlace y activa tu acceso (si es tu primera vez, crearás tu propia contraseña):",
    link,
    "",
    `Enlace personal y de un solo uso. Vence el ${expiryText(payload.expiresAt)} (hora de Puerto Rico). No lo reenvíes.`,
    `Si vence o no funciona, pide a ${payload.organizationName} que te envíe uno nuevo.`,
    "",
    "¿No esperabas esta invitación? Ignora este correo: sin activar el enlace no se crea ningún acceso.",
    `${config.senderName} nunca te pedirá tu contraseña por correo.`,
  ].join("\n");

  return { subject, html, text };
}

/**
 * Sends the invitation. "sent" only when Resend accepts it (2xx with a message id).
 * Never logs the address, the token or the link.
 */
export async function sendFamilyInvitationEmail(payload: FamilyInvitationEmail, config: EmailConfig): Promise<EmailDeliveryResult> {
  if (!config.apiKey) return { status: "failed", error: "EMAIL_NOT_CONFIGURED" };
  const { subject, html, text } = buildFamilyInvitationEmail(payload, config);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${config.senderName} <${config.senderEmail}>`, to: payload.recipientEmail, subject, html, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { status: "failed", error: `HTTP ${response.status}` };
    const result = await response.json().catch(() => ({})) as { id?: string };
    return result.id ? { status: "sent", messageId: result.id } : { status: "failed", error: "INVALID_RESPONSE" };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.name : "NETWORK_ERROR" };
  }
}
