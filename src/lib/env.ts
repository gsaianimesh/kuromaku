import { z } from "zod";

/**
 * Server-side environment. Validated once, lazily, so that a missing variable
 * surfaces as a readable error on the health page rather than a stack trace at
 * import time (which would take the whole app down and violate "never leave
 * main broken").
 */
const serverEnvSchema = z.object({
  // Pooled Neon connection, used by the app at runtime.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is not set"),
  // Direct (unpooled) connection, used by drizzle-kit for migrations.
  DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
  // 32 bytes, base64. Encrypts BYOK model keys at rest. Never logged.
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1, "APP_ENCRYPTION_KEY is not set")
    .refine(
      (v) => {
        try {
          return Buffer.from(v, "base64").length === 32;
        } catch {
          return false;
        }
      },
      { message: "APP_ENCRYPTION_KEY must be 32 bytes encoded as base64" },
    ),
  // Local-development fallback only (SPEC section 4). Production uses BYOK.
  GROQ_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/** Throws if the environment is invalid. Use inside try/catch on surfaces that report status. */
export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Non-throwing variant for status surfaces like /health. */
export function checkEnv():
  | { ok: true; env: ServerEnv }
  | { ok: false; missing: string[] } {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (parsed.success) return { ok: true, env: parsed.data };
  return {
    ok: false,
    missing: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    ),
  };
}
