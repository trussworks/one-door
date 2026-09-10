import { z } from "zod";

/**
 * Server-side environment, validated on first use.
 *
 * Validation is deliberately lazy rather than running at module load. `next
 * build` evaluates module top-level code while collecting page data, so an
 * eager check would make a production build require a reachable database URL —
 * and `npm run build` is one of the enforced harness checks, running in CI
 * where no database exists.
 */

const POSTGRES_SCHEME = /^postgres(ql)?:\/\//;

const serverEnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is not set" })
    .min(1, "DATABASE_URL is empty")
    .regex(
      POSTGRES_SCHEME,
      "DATABASE_URL must begin with postgres:// or postgresql://",
    ),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/**
 * Read the validated server environment.
 *
 * Throws in the browser instead of returning an empty value, so an accidental
 * import from a client component fails loudly at the first call rather than
 * silently handing back undefined.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error(
      "serverEnv() was called in the browser. DATABASE_URL is server-only.",
    );
  }

  if (cached) return cached;

  const result = serverEnvSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
  });

  if (!result.success) {
    // Report the failing variable and the rule it broke, never the value: the
    // connection string carries a password and this message reaches logs.
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid server environment.\n${problems}`);
  }

  cached = result.data;
  return cached;
}
