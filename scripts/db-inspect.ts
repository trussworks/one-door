import { createHash } from "node:crypto";
import { isMain } from "./is-main.mjs";
import postgres from "postgres";
import { serverEnv } from "../src/db/env.ts";

export async function inspectDatabase(sql: ReturnType<typeof postgres>) {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const [database] = await tx`SELECT current_database() AS name,
      pg_encoding_to_char(encoding) AS encoding, datcollate AS collation
      FROM pg_database WHERE datname = current_database()`;
    const names = await tx`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' ORDER BY tablename`;
    const ledger =
      await tx`SELECT name, sha256 FROM _one_door_migrations ORDER BY name`;
    const manifests =
      await tx`SELECT name, content_hash FROM _one_door_fixture_seed ORDER BY name`;
    if (
      ledger.some(
        (row) =>
          !/^\d{4}_[a-z\d_]+\.sql$/.test(row.name) ||
          !/^[a-f\d]{64}$/.test(row.sha256),
      )
    )
      throw new Error("Unexpected migration metadata");
    if (
      manifests.some(
        (row) =>
          !/^[a-z][a-z\d_-]*$/.test(row.name) ||
          !/^[a-f\d]{64}$/.test(row.content_hash),
      )
    )
      throw new Error("Unexpected fixture metadata");
    const tables: Record<string, { rows: number; sha256: string }> = {};
    for (const { tablename } of names) {
      const identifier = '"' + String(tablename).replaceAll('"', '""') + '"';
      const hash = createHash("sha256");
      let rows = 0;
      for await (const batch of tx
        .unsafe(
          `SELECT row_to_json(t)::text AS row FROM public.${identifier} t ORDER BY row_to_json(t)::text COLLATE "C"`,
        )
        .cursor(100)) {
        for (const row of batch) {
          hash.update(row.row + "\n");
          rows++;
        }
      }
      tables[String(tablename)] = { rows, sha256: hash.digest("hex") };
    }
    return {
      database,
      migrations: Object.fromEntries(
        ledger.map((row) => [row.name, row.sha256]),
      ),
      fixtures: Object.fromEntries(
        manifests.map((row) => [row.name, row.content_hash]),
      ),
      tables,
    };
  });
}

if (isMain(import.meta)) {
  const sql = postgres(serverEnv().DATABASE_URL, {
    max: 1,
    connect_timeout: 5,
  });
  try {
    console.log(JSON.stringify(await inspectDatabase(sql)));
  } catch (error) {
    console.error("database inspection failed", {
      kind: error instanceof Error ? error.name : "unknown",
    });
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
