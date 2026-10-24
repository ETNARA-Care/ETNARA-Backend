/**
 * SMS verification providers. Off by default (SMS_PROVIDER=disabled).
 *
 * - "test": nothing leaves the server; the code is kept in an in-memory outbox
 *   that only local verifiers read. Refused when NODE_ENV=production.
 * - "twilio_verify": Twilio generates, sends and checks the code (no 10DLC
 *   registration needed for verification). Implemented against the public REST
 *   API and tested with a fake; NOT contracted or enabled.
 *
 * The SMS text never contains names or health data. The test provider uses
 * the approved wording, ending with the WebOTP line Android uses to autofill.
 */
export type SmsProviderName = "test" | "twilio_verify";

export class SmsUnavailableError extends Error {
  constructor() { super("SMS_UNAVAILABLE"); this.name = "SmsUnavailableError"; }
}

export interface SmsProvider {
  readonly name: SmsProviderName;
  /** true when ETNARA generates the code (and stores its hash). */
  readonly ownCodes: boolean;
  send(phone: string, code: string | null): Promise<void>;
  /** Only for providers that keep the code themselves. */
  check?(phone: string, code: string): Promise<boolean>;
}

export const SMS_TEXT = (code: string) =>
  `ETNARA Care: tu código es ${code}. Vence en 10 minutos. No lo compartas.\n\n@app.etnaracare.com #${code}`;

// ------------------------------------------------------------------ test (local only)
const outbox: Array<{ to: string; body: string; at: number }> = [];
/** Local verifiers only. Empty (and unused) unless SMS_PROVIDER=test outside production. */
export function testSmsOutbox(): ReadonlyArray<{ to: string; body: string; at: number }> { return outbox; }

export const testProvider: SmsProvider = {
  name: "test",
  ownCodes: true,
  async send(phone, code) {
    if (!code) throw new SmsUnavailableError();
    outbox.push({ to: phone, body: SMS_TEXT(code), at: Date.now() });
  },
};

// ------------------------------------------------------------------ Twilio Verify
type FetchLike = typeof fetch;
export function twilioVerifyProvider(cfg: { accountSid: string; authToken: string; serviceSid: string }, fetchImpl: FetchLike = fetch): SmsProvider {
  const base = `https://verify.twilio.com/v2/Services/${cfg.serviceSid}`;
  const auth = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`;
  async function post(path: string, form: Record<string, string>) {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return { ok: res.ok, status: res.status, body };
  }
  return {
    name: "twilio_verify",
    ownCodes: false,
    async send(phone) {
      const r = await post("/Verifications", { To: phone, Channel: "sms", Locale: "es" });
      if (!r.ok) throw new SmsUnavailableError();
    },
    async check(phone, code) {
      const r = await post("/VerificationCheck", { To: phone, Code: code });
      // 404 = no pending verification (expired/used): a wrong code for us.
      if (r.status === 404) return false;
      if (!r.ok) throw new SmsUnavailableError();
      return r.body.status === "approved";
    },
  };
}

