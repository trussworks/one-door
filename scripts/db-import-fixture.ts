import { createDatabase } from "../src/db/client.ts";
import { importArchitectureFixture } from "../src/seed/fixture-import.ts";

const { db, sql: client } = createDatabase();
let imported = false;
try {
  imported = await importArchitectureFixture(db);
} finally {
  await client.end();
}

console.log(
  imported
    ? "Imported architecture fixture 2026-09-10 and reopened two conflicts."
    : "Architecture fixture 2026-09-10 already matches; no rows changed.",
);
