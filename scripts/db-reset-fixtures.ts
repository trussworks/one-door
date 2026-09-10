import { createDatabase } from "../src/db/client.ts";
import { resetFixtureState } from "../src/seed/fixture-reset.ts";

if (!process.argv.includes("--confirm-fixture-reset")) {
  throw new Error(
    "Fixture reset requires --confirm-fixture-reset because it reverts live edits to shared fixture records.",
  );
}

const { db, sql: client } = createDatabase();
try {
  await resetFixtureState(db);
} finally {
  await client.end();
}

console.log(
  "Fixture state restored. Visitor work, task completions, model usage, and audit history were preserved.",
);
