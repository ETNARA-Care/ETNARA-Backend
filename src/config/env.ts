import { z } from "zod";

/**
 * Environment variable validation. Fails fast at startup -- the process
 * must not boot with a missing or malformed required variable. Only what
 * is strictly needed to connect to PostgreSQL and run the server is
 * included here; nothing for future features (payments, storage providers,
 * etc.) belongs in this file yet.
 */
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
  // PGPOOL_MAX: maximum number of physical connections the app's pg Pool
  // will open. Strictly necessary to connect sensibly in every
  // environment (a test suite and a production API need very different
  // pool sizes) -- not a "future feature" flag.
  PGPOOL_MAX: z
    .string()
    .default("10")
    .transform((val) => Number.parseInt(val, 10))
    .pipe(z.number().int().positive()),
  // How long a session remains valid after login. Not eternal -- required
  // for a real expiration test and for basic security hygiene.
  SESSION_DURATION_HOURS: z
    .string()
    .default("12")
    .transform((val) => Number.parseInt(val, 10))
    .pipe(z.number().int().positive()),
  // CORS: the exact origin(s) allowed to call this API with credentials.
  // Comma-separated if more than one is ever needed. No default of "*" --
  // an explicit allowlist is required for any authenticated API.
  ALLOWED_ORIGIN: z.string().default("https://rafaelvegafigueroa-eng.github.io"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast and loud. No partial boot with a broken config.
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:");
    // eslint-disable-next-line no-console
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Environment validation failed -- refusing to start.");
  }
  return parsed.data;
}

export const env = loadEnv();
