import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import { serverEnv } from "../db/env.ts";
import { authConfiguration } from "./auth.ts";

// process.cwd(), not import.meta.url: this module runs bundled inside the
// Next server, where source-relative paths no longer point at the repository.
const migrationsDirectory = path.join(process.cwd(), "migrations");

/**
 * Refuse to serve before the environment can support requests: auth
 * configuration present, database reachable, and every migration in this
 * image applied with an unchanged checksum. Applied migrations newer than
 * the image are allowed so a rolled-back image can run against an
 * expand/contract schema.
 */
export async function validateWebStartup(): Promise<void> {
  try {
    authConfiguration();
  } catch {
    throw new Error(
      "web startup blocked: set DEMO_ACCESS_CODE (12+ chars) and SESSION_SECRET (32+ chars)",
    );
  }

  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (names.length === 0)
    throw new Error("web startup blocked: no migration files in this image");

  const sql = postgres(serverEnv().DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    let applied: { name: string; sha256: string }[];
    try {
      applied = await sql`SELECT name, sha256 FROM _one_door_migrations`;
    } catch {
      // The error may carry connection details; report the condition only.
      throw new Error(
        "web startup blocked: no migration ledger. Check DATABASE_URL and run db:migrate first",
      );
    }
    const appliedByName = new Map(applied.map((row) => [row.name, row.sha256]));
    for (const name of names) {
      const file = await readFile(path.join(migrationsDirectory, name));
      const sha256 = createHash("sha256").update(file).digest("hex");
      const appliedHash = appliedByName.get(name);
      if (!appliedHash)
        throw new Error(
          `web startup blocked: migration not applied: ${name}. Run db:migrate before starting the web server`,
        );
      if (appliedHash !== sha256)
        throw new Error(
          `web startup blocked: applied migration differs from this image: ${name}`,
        );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
