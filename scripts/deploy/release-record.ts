// The release record states what a release contains, and the gate compares two
// records before a rolling deployment. Workers mark a job superseded when the
// running prompt version differs from the job's (src/models/worker.ts), so old
// and new workers must never share a queue across a contract change.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isMain } from "../is-main.mjs";
import {
  modelJobStatuses,
  modelPurposes,
  modelStatuses,
} from "../../src/domain/constants.ts";
import { modelPrompts } from "../../src/models/prompts.ts";
import { buildSeedData } from "../../src/seed/build.ts";
import { contentHash } from "../../src/seed/stable.ts";
import { parseImageReference } from "./verify-release.ts";

export interface ReleaseRecord {
  releaseId: string;
  sourceRevision: string;
  image: string;
  imageDigest: string;
  assetsManifestSha256: string;
  dependencyLockSha256: string;
  terraformLocks: Record<string, string>;
  migrations: Record<string, string>;
  fixtureHash: string;
  jobContracts: {
    prompts: Record<string, string>;
    purposes: string[];
    jobStatuses: string[];
    callStatuses: string[];
  };
}

export function migrationChecksums(directory: string): Record<string, string> {
  const names = readdirSync(directory)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (names.length === 0)
    throw new Error("No SQL migrations were found: " + directory);
  return Object.fromEntries(
    names.map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(path.join(directory, name)))
        .digest("hex"),
    ]),
  );
}

/** The contract a running worker enforces, taken from the source it runs. */
export function jobContracts(): ReleaseRecord["jobContracts"] {
  return {
    prompts: Object.fromEntries(
      Object.entries(modelPrompts).map(([purpose, prompt]) => [
        purpose,
        prompt.version,
      ]),
    ),
    purposes: [...modelPurposes],
    jobStatuses: [...modelJobStatuses],
    callStatuses: [...modelStatuses],
  };
}

export function buildRecord(input: {
  releaseId: string;
  sourceRevision: string;
  image: string;
  assetsManifestSha256: string;
  migrationsDirectory: string;
}): ReleaseRecord {
  if (!/^[0-9a-f]{40}$/.test(input.sourceRevision))
    throw new Error("The source revision must be a full commit identifier");
  if (!/^[a-f0-9]{64}$/.test(input.assetsManifestSha256))
    throw new Error("The asset manifest checksum must be a SHA-256 digest");
  return {
    releaseId: input.releaseId,
    sourceRevision: input.sourceRevision,
    image: input.image,
    imageDigest: parseImageReference(input.image).digest,
    assetsManifestSha256: input.assetsManifestSha256,
    dependencyLockSha256: createHash("sha256")
      .update(readFileSync(new URL("../../package-lock.json", import.meta.url)))
      .digest("hex"),
    terraformLocks: Object.fromEntries(
      ["bootstrap", "platform", "release", "install"].map((stack) => [
        stack,
        createHash("sha256")
          .update(
            readFileSync(
              new URL(
                `../../infra/${stack}/.terraform.lock.hcl`,
                import.meta.url,
              ),
            ),
          )
          .digest("hex"),
      ]),
    ),
    migrations: migrationChecksums(input.migrationsDirectory),
    fixtureHash: contentHash(buildSeedData()),
    jobContracts: jobContracts(),
  };
}

export interface Compatibility {
  decision: "rolling" | "maintenance";
  blocking: string[];
  notes: string[];
}

function compareMigrations(
  previous: ReleaseRecord,
  candidate: ReleaseRecord,
  result: Compatibility,
): void {
  for (const [name, sha256] of Object.entries(previous.migrations)) {
    const now = candidate.migrations[name];
    if (now === undefined)
      result.blocking.push(`migration removed from the release: ${name}`);
    else if (now !== sha256)
      result.blocking.push(`applied migration changed content: ${name}`);
  }
  const added = Object.keys(candidate.migrations).filter(
    (name) => !(name in previous.migrations),
  );
  if (added.length > 0)
    result.notes.push(`new migrations: ${added.join(", ")}`);
}

function compareContracts(
  previous: ReleaseRecord,
  candidate: ReleaseRecord,
  result: Compatibility,
): void {
  const before = previous.jobContracts;
  const after = candidate.jobContracts;
  for (const purpose of new Set([
    ...Object.keys(before.prompts),
    ...Object.keys(after.prompts),
  ])) {
    const was = before.prompts[purpose];
    const now = after.prompts[purpose];
    if (was !== now)
      result.blocking.push(
        `prompt version changed for ${purpose}: ${was ?? "absent"} to ${now ?? "absent"}`,
      );
  }
  for (const field of ["purposes", "jobStatuses", "callStatuses"] as const) {
    if (before[field].join(",") !== after[field].join(","))
      result.blocking.push(`job contract changed: ${field}`);
  }
}

/**
 * A blocking difference means old and new workers would interpret the same
 * queue differently. Draining under the old contract first is the release
 * procedure; this gate only reports, and never advances a service.
 */
export function compareRecords(
  previous: ReleaseRecord,
  candidate: ReleaseRecord,
): Compatibility {
  const result: Compatibility = {
    decision: "rolling",
    blocking: [],
    notes: [],
  };
  compareMigrations(previous, candidate, result);
  compareContracts(previous, candidate, result);
  if (previous.fixtureHash !== candidate.fixtureHash)
    result.notes.push(
      "reference fixture changed; run the guarded fixture upgrade before service rollout",
    );
  if (previous.imageDigest === candidate.imageDigest)
    result.notes.push("the candidate image is already the released image");
  if (result.blocking.length > 0) result.decision = "maintenance";
  return result;
}

function readRecord(file: string): ReleaseRecord {
  return JSON.parse(readFileSync(file, "utf8")) as ReleaseRecord;
}

if (isMain(import.meta)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "build") {
    const [releaseId, sourceRevision, image, assetsManifestSha256] = rest;
    if (!releaseId || !sourceRevision || !image || !assetsManifestSha256)
      throw new Error(
        "Usage: release-record.ts build RELEASE_ID SOURCE_REVISION IMAGE_DIGEST_REFERENCE ASSETS_MANIFEST_SHA256",
      );
    console.log(
      JSON.stringify(
        buildRecord({
          releaseId,
          sourceRevision,
          image,
          assetsManifestSha256,
          migrationsDirectory: path.resolve("migrations"),
        }),
        null,
        2,
      ),
    );
  } else if (command === "compare") {
    const [previousFile, candidateFile] = rest;
    if (!previousFile || !candidateFile)
      throw new Error(
        "Usage: release-record.ts compare PREVIOUS_RECORD CANDIDATE_RECORD",
      );
    const result = compareRecords(
      readRecord(previousFile),
      readRecord(candidateFile),
    );
    console.log(JSON.stringify(result));
    if (result.decision === "maintenance") {
      console.error(
        "A rolling deployment is refused. Pause new work, let the running workers drain the queued jobs under the previous contract, then release during a maintenance window.",
      );
      process.exitCode = 1;
    } else {
      console.log(
        "Rolling deployment is compatible with the previous release.",
      );
    }
  } else {
    throw new Error("Usage: release-record.ts build|compare ...");
  }
}
