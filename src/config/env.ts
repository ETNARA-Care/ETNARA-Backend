import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z
    .string()
    .default("3000")
    .transform((val) => Number.parseInt(val, 10))
    .pipe(z.number().int().positive()),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((val) => val.startsWith("postgres://") || val.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a valid postgres connection string",
    }),
  PGPOOL_MAX: z
    .string()
    .default("10")
    .transform((val) => Number.parseInt(val, 10))
    .pipe(z.number().int().positive()),
  SESSION_DURATION_HOURS: z
    .string()
    .default("12")
    .transform((val) => Number.parseInt(val, 10))
    .pipe(z.number().int().positive()),
  // Phase 12.4: caregiver-only accounts keep the session on the device for
  // up to 7 days so the app works where there is no signal.
  WORKER_SESSION_DURATION_HOURS: z
    .string()
    .default("168")
    .transform((val) => Number.parseInt(val, 10))
    .pipe(z.number().int().positive().max(168)),
  ALLOWED_ORIGIN: z.string().default("https://rafaelvegafigueroa-eng.github.io"),
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().min(1).optional(),
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  STORAGE_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  STORAGE_MAX_FILE_BYTES: z
    .string()
    .default("10485760")
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().positive()),
  // Activity photos (PR 2): a SEPARATE private bucket. Never falls back to STORAGE_*.
  PHOTO_STORAGE_ENDPOINT: z.string().url().optional(),
  PHOTO_STORAGE_REGION: z.string().min(1).optional(),
  PHOTO_STORAGE_BUCKET: z.string().min(1).optional(),
  PHOTO_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  PHOTO_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  PHOTO_STORAGE_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  PHOTO_MAX_UPLOAD_BYTES: z
    .string()
    .default("15728640")
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().positive().max(20 * 1024 * 1024)),
  // Phone linking + SMS recovery (migration 117). OFF until a provider is contracted and approved.
  PHONE_VERIFICATION_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // "test" keeps codes in memory for local verification only and is refused in production.
  SMS_PROVIDER: z.enum(["disabled", "test", "twilio_verify"]).default("disabled"),
  PHONE_CODE_SECRET: z.string().min(32).optional(),
  SMS_DAILY_CAP: z.string().default("200").transform((v) => Number.parseInt(v, 10)).pipe(z.number().int().positive().max(100000)),
  // Accounts created from this date on must link a phone (staff); older ones are only reminded.
  PHONE_REQUIRED_SINCE: z.string().datetime({ offset: true }).optional(),
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-f]{32}$/).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().regex(/^VA[0-9a-f]{32}$/).optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_SENDER_ADDRESS: z.string().email().default("invitations@etnara.care"),
  EMAIL_SENDER_NAME: z.string().default("ETNARA Care"),
  ACTIVATION_BASE_URL: z.string().url().default("https://app.etnara.care"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Environment validation failed -- refusing to start.");
  }
  return parsed.data;
}

export const env = loadEnv();

