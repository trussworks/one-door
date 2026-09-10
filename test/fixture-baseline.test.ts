import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { baselineFixture, fixtureDigest } from "./fixture-baseline.ts";

it("accepts both upgrade baselines as committed", () => {
  expect(baselineFixture("189cf874fd03")).toContain("189cf874fd03");
  expect(baselineFixture("26c0cd748c5a")).toContain("26c0cd748c5a");
});

// The directory is retained, and a file leaves the hashed subtree by moving to a
// sibling rather than by deletion, because this repository deletes nothing.
it("changes the digest when a file is added, edited, or missing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "one-door-fixture-digest-"));
  console.log("retained digest workspace:", workspace);
  const subject = join(workspace, "subject");
  const outside = join(workspace, "moved-out");
  mkdirSync(join(subject, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(subject, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(subject, "src", "seed.ts"), "export const n = 1;\n");
  const original = fixtureDigest(subject);

  writeFileSync(join(subject, "src", "extra.ts"), "");
  expect(fixtureDigest(subject), "an added file").not.toBe(original);
  renameSync(join(subject, "src", "extra.ts"), join(outside, "extra.ts"));
  expect(fixtureDigest(subject), "the added file moved out").toBe(original);

  writeFileSync(join(subject, "src", "seed.ts"), "export const n = 2;\n");
  const edited = fixtureDigest(subject);
  expect(edited, "an edited file").not.toBe(original);

  renameSync(join(subject, "src", "seed.ts"), join(outside, "seed.ts"));
  const missing = fixtureDigest(subject);
  expect(missing, "a missing file").not.toBe(original);
  expect(
    missing,
    "a missing file reads differently from an edited one",
  ).not.toBe(edited);
});
