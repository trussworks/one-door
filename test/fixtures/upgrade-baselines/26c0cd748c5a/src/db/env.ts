import { z } from "zod";

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

// Validate on first use so a Next build does not require runtime credentials.
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
    // The connection string contains a password; errors must not echo it.
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid server environment.\n${problems}`);
  }

  cached = result.data;
  return cached;
}
