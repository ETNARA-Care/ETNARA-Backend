import type { EmailDeliveryResult } from "../email/email.service.js";

/** What Central sees of an email delivery: a fixed code, never the provider's message or message id. */
export type CentralEmailDelivery = { status: "sent" | "failed"; error?: "EMAIL_NOT_CONFIGURED" | "EMAIL_SEND_FAILED" };

export function centralEmailDelivery(result: EmailDeliveryResult): CentralEmailDelivery {
  if (result.status === "sent") return { status: "sent" };
  return { status: "failed", error: result.error === "EMAIL_NOT_CONFIGURED" ? "EMAIL_NOT_CONFIGURED" : "EMAIL_SEND_FAILED" };
}
