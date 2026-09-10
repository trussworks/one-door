import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

import {
  buildRecord,
  compareRecords,
  jobContracts,
  migrationChecksums,
  type ReleaseRecord,
} from "../../scripts/deploy/release-record.ts";

const parent = path.resolve(".harness/deployment-unit");
mkdirSync(parent, { recursive: true });
const REVISION = "a".repeat(40);
const MANIFEST = "b".repeat(64);
const IMAGE =
  "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@sha256:" +
  "c".repeat(64);

function migrations(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(parent, "migrations-"));
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(root, name), body);
  return root;
}

function record(overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    ...buildRecord({
      releaseId: "abc123-9-1",
      sourceRevision: REVISION,
      image: IMAGE,
      assetsManifestSha256: MANIFEST,
      migrationsDirectory: migrations({
        "0001_initial.sql": "create table a();",
      }),
    }),
    ...overrides,
  };
}

it("records the source revision, image digest, migrations and contracts", () => {
  const built = record();
  expect(built.sourceRevision).toBe(REVISION);
  expect(built.imageDigest).toBe("sha256:" + "c".repeat(64));
  expect(Object.keys(built.migrations)).toEqual(["0001_initial.sql"]);
  expect(built.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
  // Taken from the source the worker runs, not restated in the test.
  expect(built.jobContracts).toEqual(jobContracts());
  expect(Object.keys(built.jobContracts.prompts).length).toBeGreaterThan(0);
});

it("refuses a record that cannot identify its own source or assets", () => {
  const directory = migrations({ "0001_initial.sql": "create table a();" });
  expect(() =>
    buildRecord({
      releaseId: "abc123-9-1",
      sourceRevision: "abbreviated",
      image: IMAGE,
      assetsManifestSha256: MANIFEST,
      migrationsDirectory: directory,
    }),
  ).toThrow("source revision");
  expect(() =>
    buildRecord({
      releaseId: "abc123-9-1",
      sourceRevision: REVISION,
      image: IMAGE,
      assetsManifestSha256: "not-a-digest",
      migrationsDirectory: directory,
    }),
  ).toThrow("manifest checksum");
  expect(() =>
    buildRecord({
      releaseId: "abc123-9-1",
      sourceRevision: REVISION,
      image: "one-door-personal:latest",
      assetsManifestSha256: MANIFEST,
      migrationsDirectory: directory,
    }),
  ).toThrow("digest reference");
});

it("checksums only numbered SQL migrations and refuses an empty directory", () => {
  const checksums = migrationChecksums(
    migrations({
      "0001_initial.sql": "create table a();",
      "notes.md": "ignore me",
    }),
  );
  expect(Object.keys(checksums)).toEqual(["0001_initial.sql"]);
  expect(() => migrationChecksums(migrations({}))).toThrow("No SQL migrations");
});

it("allows a rolling release when nothing incompatible changed", () => {
  const previous = record();
  const candidate = record({ imageDigest: "sha256:" + "d".repeat(64) });
  expect(compareRecords(previous, candidate)).toEqual({
    decision: "rolling",
    blocking: [],
    notes: [],
  });
});

it("refuses a rolling release when a prompt version changed", () => {
  const previous = record();
  const [purpose] = Object.keys(previous.jobContracts.prompts);
  const candidate = record({
    jobContracts: {
      ...previous.jobContracts,
      prompts: { ...previous.jobContracts.prompts, [purpose]: "intake-v99" },
    },
  });
  const result = compareRecords(previous, candidate);
  expect(result.decision).toBe("maintenance");
  expect(result.blocking[0]).toContain(`prompt version changed for ${purpose}`);
});

it("refuses a rolling release when the job contract changed shape", () => {
  const previous = record();
  for (const field of ["purposes", "jobStatuses", "callStatuses"] as const) {
    const candidate = record({
      jobContracts: {
        ...previous.jobContracts,
        [field]: [...previous.jobContracts[field], "invented"],
      },
    });
    const result = compareRecords(previous, candidate);
    expect(result.decision, field).toBe("maintenance");
    expect(result.blocking).toContain(`job contract changed: ${field}`);
  }
});

it("refuses a release that rewrites or drops an applied migration", () => {
  const previous = record();
  const changed = compareRecords(
    previous,
    record({ migrations: { "0001_initial.sql": "0".repeat(64) } }),
  );
  expect(changed.decision).toBe("maintenance");
  expect(changed.blocking[0]).toContain("changed content");

  const dropped = compareRecords(previous, record({ migrations: {} }));
  expect(dropped.decision).toBe("maintenance");
  expect(dropped.blocking[0]).toContain("removed from the release");
});

it("allows added migrations and a changed fixture, and says so", () => {
  const previous = record();
  const candidate = record({
    migrations: { ...previous.migrations, "0002_next.sql": "1".repeat(64) },
    fixtureHash: "2".repeat(64),
  });
  const result = compareRecords(previous, candidate);
  expect(result.decision).toBe("rolling");
  expect(result.notes).toContain("new migrations: 0002_next.sql");
  expect(result.notes.join(" ")).toContain("reference fixture changed");
});
