import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { Platform } from "../../scripts/deploy/aws.ts";
import {
  promotionRecord,
  verifyLayout,
} from "../../scripts/deploy/promote-image.ts";
import { buildRecord } from "../../scripts/deploy/release-record.ts";

const p = {
  environment: "truss",
  repository_url: "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss",
} as Platform;

it("rebinds only the destination URI while preserving the approved image's identities", () => {
  const source = buildRecord({
    releaseId: "approved-1",
    sourceRevision: "a".repeat(40),
    image:
      "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@sha256:" +
      "b".repeat(64),
    assetsManifestSha256: "c".repeat(64),
    migrationsDirectory: "migrations",
  });
  expect(promotionRecord(p, source, source.sourceRevision)).toEqual({
    ...source,
    image: p.repository_url + "@" + source.imageDigest,
  });
  expect(() => promotionRecord(p, source, "d".repeat(40))).toThrow(
    "source revision differs",
  );
  expect(() =>
    promotionRecord(
      { ...p, environment: "personal" },
      source,
      source.sourceRevision,
    ),
  ).toThrow("must be Truss");
  for (const change of [
    { image: p.repository_url + "@" + source.imageDigest },
    { imageDigest: "sha256:" + "d".repeat(64) },
    { releaseId: "../escape" },
  ]) {
    expect(() =>
      promotionRecord(p, { ...source, ...change }, source.sourceRevision),
    ).toThrow();
  }
});

function layout() {
  const parent = path.resolve(".harness/promotion-layout-tests");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "case-"));
  mkdirSync(path.join(directory, "blobs/sha256"), { recursive: true });
  function blob(value: unknown, mediaType: string) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(path.join(directory, "blobs/sha256", digest), bytes);
    return { mediaType, digest: "sha256:" + digest, size: bytes.length };
  }
  const config = blob(
    {
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
    },
    "application/vnd.oci.image.config.v1+json",
  );
  const attestation = blob(
    {
      _type: "https://in-toto.io/Statement/v0.1",
      predicateType: "https://spdx.dev/Document",
    },
    "application/vnd.in-toto+json",
  );
  const image = blob(
    { schemaVersion: 2, config, layers: [] },
    "application/vnd.oci.image.manifest.v1+json",
  );
  const proof = blob(
    { schemaVersion: 2, config, layers: [attestation] },
    "application/vnd.oci.image.manifest.v1+json",
  );
  const root = blob(
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [image, proof],
    },
    "application/vnd.oci.image.index.v1+json",
  );
  writeFileSync(
    path.join(directory, "oci-layout"),
    JSON.stringify({ imageLayoutVersion: "1.0.0" }),
  );
  writeFileSync(
    path.join(directory, "index.json"),
    JSON.stringify({ schemaVersion: 2, manifests: [root] }),
  );
  return {
    directory,
    root,
    attestation,
    digests: [root, config, image, proof, attestation]
      .map((entry) => entry.digest)
      .sort(),
  };
}

it("verifies the complete image and attestation graph, and refuses corruption or a missing proof", () => {
  const { directory, root, attestation, digests } = layout();
  expect(verifyLayout(directory, root.digest)).toEqual(digests);
  expect(() => verifyLayout(directory, "sha256:" + "a".repeat(64))).toThrow(
    "digest changed",
  );
  const file = path.join(
    directory,
    "blobs/sha256",
    attestation.digest.slice(7),
  );
  const original = readFileSync(file);
  writeFileSync(file, Buffer.alloc(original.length, 32));
  expect(() => verifyLayout(directory, root.digest)).toThrow(
    "blob digest differs",
  );
  writeFileSync(file, original.subarray(1));
  expect(() => verifyLayout(directory, root.digest)).toThrow(
    "blob size differs",
  );
  renameSync(file, file + ".retained-corrupt");
  expect(() => verifyLayout(directory, root.digest)).toThrow("ENOENT");
});
