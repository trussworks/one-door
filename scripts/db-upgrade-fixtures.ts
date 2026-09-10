import { createDatabase } from "../src/db/client.ts";
import { upgradeFixtureState } from "../src/seed/fixture-upgrade.ts";

if (!process.argv.includes("--confirm-fixture-upgrade")) {
  throw new Error(
    "Fixture upgrade requires --confirm-fixture-upgrade because it appends corrected reference evidence to the installed fixtures.",
  );
}

const { db, sql: client } = createDatabase();
try {
  const outcome = await upgradeFixtureState(db);
  if (outcome.status === "already-current") {
    console.log("Reference fixtures already match this build; nothing to do.");
  } else {
    console.log(
      `Reference fixtures upgraded: ${outcome.insertedRows} corrected evidence rows added. ` +
        "Live rows and immutable evidence were preserved.",
    );
  }
} finally {
  await client.end();
}
