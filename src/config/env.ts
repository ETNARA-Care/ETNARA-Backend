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

