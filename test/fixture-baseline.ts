import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(
  new URL("fixtures/upgrade-baselines/", import.meta.url),
);

// Each fixture holds the verbatim migrate-and-seed sources of one historical
// commit, because the Truss repository starts from a single parentless commit
// and cannot check that commit out. The digest is pinned here rather than in the
// fixture so that editing a fixture file cannot also move the value it is
// compared against.
const BASELINES = {
  "189cf874fd03": {
    commit: "189cf874fd03e91ce5d696ea0e0c5d36c11dc7aa",
    digest: "be1ba3ab442263beccab382894f6c98bb3743fe62e35c3ec1f635a76b2beafea",
  },
  "26c0cd748c5a": {
    commit: "26c0cd748c5a54714a6cc6b88e566f317cbb53b3",
    digest: "b33d1e4389f31804506d56770c4ee3a6d160914e8572e2ec84a0755b2126287a",
  },
} as const;

/** Digest of the complete file set: every path, sorted, with its content hash. */
export function fixtureDigest(directory: string): string {
  const lines: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, name + "/");
      else
        lines.push(
          name +
            " " +
            createHash("sha256").update(readFileSync(full)).digest("hex"),
        );
    }
  };
  walk(directory, "");
  return createHash("sha256")
    .update(lines.sort().join("\n") + "\n")
    .digest("hex");
}

export function baselineFixture(name: keyof typeof BASELINES): string {
  const baseline = BASELINES[name];
  const directory = join(root, name);
  assert.equal(
    fixtureDigest(directory),
    baseline.digest,
    "Baseline fixture " +
      name +
      " no longer matches commit " +
      baseline.commit +
      "; a file was added, deleted, or edited. Compare it against " +
      join(directory, "manifest.json") +
      " and restore the recorded bytes.",
  );
  return directory;
}
