import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import postgres from "postgres";

import { serverEnv } from "../src/db/env.ts";

const migrationsDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();

if (migrationNames.length === 0) throw new Error("No SQL migrations found");

const client = postgres(serverEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
let appliedCount = 0;

try {
  await client.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(9248661)`;
    await transaction`
      CREATE TABLE IF NOT EXISTS _one_door_migrations (
        name text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = await transaction<{ name: string; sha256: string }[]>`
      SELECT name, sha256 FROM _one_door_migrations
    `;
    const appliedByName = new Map(
      applied.map((migration) => [migration.name, migration.sha256]),
    );

    for (const name of migrationNames) {
      const migration = await readFile(
        new URL(name, migrationsDirectory),
        "utf8",
      );
      const sha256 = createHash("sha256").update(migration).digest("hex");
      const appliedHash = appliedByName.get(name);

      if (appliedHash && appliedHash !== sha256) {
        throw new Error(`Applied migration changed: ${name}`);
      }
      if (appliedHash) continue;

      await transaction.unsafe(migration);
      await transaction`
        INSERT INTO _one_door_migrations (name, sha256)
        VALUES (${name}, ${sha256})
      `;
      appliedCount += 1;
    }
  });
} finally {
  await client.end();
}

console.log(`Applied ${appliedCount} migration(s).`);
