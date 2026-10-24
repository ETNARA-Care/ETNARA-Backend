import { env } from "../../config/env.js";
import { testProvider, twilioVerifyProvider, type SmsProvider } from "./smsCore.js";

export { SMS_TEXT, SmsUnavailableError, testSmsOutbox, twilioVerifyProvider, type SmsProvider, type SmsProviderName } from "./smsCore.js";

/** The configured provider, or null when phone verification is off. */
export function activeSmsProvider(): SmsProvider | null {
  if (!env.PHONE_VERIFICATION_ENABLED || !env.PHONE_CODE_SECRET) return null;
  if (env.SMS_PROVIDER === "test") return env.NODE_ENV === "production" ? null : testProvider;
  if (env.SMS_PROVIDER === "twilio_verify" && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID) {
    return twilioVerifyProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, serviceSid: env.TWILIO_VERIFY_SERVICE_SID });
  }
  return null;
}
