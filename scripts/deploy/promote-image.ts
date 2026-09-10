import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isMain } from "../is-main.mjs";
import {
  aws,
  AwsError,
  readPlatform,
  requireAccount,
  resolveTool,
  type Platform,
} from "./aws.ts";
import type { ReleaseRecord } from "./release-record.ts";
import { deploymentTarget } from "./targets.ts";
import { requireReleaseInputs } from "./upload-assets.ts";
import { parseImageReference } from "./verify-release.ts";

interface Descriptor {
  digest: string;
  size: number;
  mediaType: string;
}

// Read every referenced byte back from the destination, including attestation
// layers; a matching index alone would not establish a complete copy.
export function verifyLayout(
  directory: string,
  expectedDigest: string,
): string[] {
  const index = JSON.parse(
    readFileSync(path.join(directory, "index.json"), "utf8"),
  );
  assert.equal(index.manifests.length, 1, "Expected one copied image root");
  assert.equal(
    index.manifests[0].digest,
    expectedDigest,
    "Copied image digest changed",
  );
  const verified = new Set<string>();
  function visit(descriptor: Descriptor, manifestRequired = false): void {
    assert.match(descriptor.digest, /^sha256:[a-f0-9]{64}$/);
    const bytes = readFileSync(
      path.join(directory, "blobs", "sha256", descriptor.digest.slice(7)),
    );
    assert.equal(bytes.length, descriptor.size, "Copied blob size differs");
    assert.equal(
      "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      descriptor.digest,
      "Copied blob digest differs",
    );
    if (verified.has(descriptor.digest)) return;
    verified.add(descriptor.digest);
    if (/image\.index|manifest\.list/.test(descriptor.mediaType)) {
      const manifest = JSON.parse(bytes.toString());
      assert.ok(
        Array.isArray(manifest.manifests) && manifest.manifests.length > 0,
      );
      manifest.manifests.forEach((child: Descriptor) => visit(child, true));
    } else if (
      /image\.manifest|distribution\.manifest\.v2/.test(descriptor.mediaType)
    ) {
      const manifest = JSON.parse(bytes.toString());
      assert.ok(manifest.config && Array.isArray(manifest.layers));
      visit(manifest.config);
      manifest.layers.forEach((layer: Descriptor) => visit(layer));
    } else {
      assert.ok(!manifestRequired, "Unsupported copied manifest type");
    }
  }
  visit(index.manifests[0], true);
  return [...verified].sort();
}

export function promotionRecord(
  p: Platform,
  record: ReleaseRecord,
  revision: string,
): ReleaseRecord {
  assert.equal(p.environment, "truss", "Promotion destination must be Truss");
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(
    record.sourceRevision,
    revision,
    "Approved source revision differs",
  );
  const source = deploymentTarget("personal");
  const repository = `${source.account_id}.dkr.ecr.${source.region}.amazonaws.com/${source.name}`;
  requireReleaseInputs(repository, record.image, record.releaseId);
  const { digest } = parseImageReference(record.image);
  assert.equal(record.imageDigest, digest, "Release record digest differs");
  requireReleaseInputs(
    p.repository_url,
    p.repository_url + "@" + digest,
    record.releaseId,
  );
  return { ...record, image: p.repository_url + "@" + digest };
}

function tagDigest(p: Platform, tag: string): string | null {
  try {
    const result = aws<{ imageDetails: Array<{ imageDigest: string }> }>([
      "ecr",
      "describe-images",
      "--region",
      p.region,
      "--repository-name",
      p.name,
      "--image-ids",
      "imageTag=" + tag,
    ]);
    assert.equal(result.imageDetails.length, 1);
    return result.imageDetails[0].imageDigest;
  } catch (error) {
    if (error instanceof AwsError && error.code === "ImageNotFoundException")
      return null;
    throw error;
  }
}

function docker(args: string[]): string {
  return execFileSync(resolveTool("docker"), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 8 * 1024 * 1024,
  });
}

function toolRevision(): string {
  const git = (args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=no"]),
    "",
    "Commit the reviewed deployment changes before promotion",
  );
  git(["ls-files", "--error-unmatch", "scripts/deploy/promote-image.ts"]);
  const revision = git(["rev-parse", "HEAD"]);
  assert.match(revision, /^[0-9a-f]{40}$/);
  return revision;
}

function requireImmutableRepository(p: Platform): void {
  const repository = aws<{
    repositories: Array<{ repositoryUri: string; imageTagMutability: string }>;
  }>([
    "ecr",
    "describe-repositories",
    "--region",
    p.region,
    "--repository-names",
    p.name,
  ]).repositories;
  assert.equal(repository.length, 1);
  assert.equal(repository[0].repositoryUri, p.repository_url);
  assert.equal(
    repository[0].imageTagMutability,
    "IMMUTABLE",
    "Promotion requires immutable destination tags",
  );
}

export function promoteImage(
  platformFile: string,
  sourceFile: string,
  revision: string,
  directory: string,
): void {
  const p = readPlatform(platformFile);
  const source = JSON.parse(readFileSync(sourceFile, "utf8")) as ReleaseRecord;
  const promoted = promotionRecord(p, source, revision);
  requireAccount(p);
  requireImmutableRepository(p);
  const existing = tagDigest(p, source.releaseId);
  assert.ok(
    existing === null || existing === source.imageDigest,
    "Destination tag already names another image",
  );
  const deploymentToolRevision = toolRevision();
  mkdirSync(directory, { mode: 0o700 });
  const version = docker(["buildx", "version"]).trim();
  if (existing === null)
    docker([
      "buildx",
      "imagetools",
      "create",
      "--prefer-index=false",
      "--tag",
      p.repository_url + ":" + source.releaseId,
      source.image,
    ]);
  assert.equal(
    tagDigest(p, source.releaseId),
    source.imageDigest,
    "Destination tag did not retain the approved digest",
  );
  const layout = path.resolve(directory, "image");
  docker([
    "buildx",
    "imagetools",
    "create",
    "--prefer-index=false",
    "--tag",
    "oci-layout://" + layout + ":verified",
    promoted.image,
  ]);
  const verified = verifyLayout(layout, source.imageDigest);
  const write = (name: string, value: unknown) =>
    writeFileSync(
      path.join(directory, name),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  write("source-release.json", source);
  write("release.json", promoted);
  write("image.json", {
    sourceRevision: revision,
    releaseId: source.releaseId,
    image: promoted.image,
    account: p.account_id,
    region: p.region,
  });
  write("promotion.json", {
    copiedAt: new Date().toISOString(),
    source: source.image,
    destination: promoted.image,
    sourceRevision: revision,
    releaseId: source.releaseId,
    buildx: version,
    deploymentToolRevision,
    verifiedBlobs: verified,
    scan: "pending",
  });
  console.log(
    "Image copied and read back; destination scanning is still required:",
    directory,
  );
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args.some((arg) => !arg))
    throw new Error(
      "Usage: promote-image.ts PLATFORM_JSON SOURCE_RELEASE_JSON SOURCE_REVISION NEW_PRIVATE_DIRECTORY",
    );
  promoteImage(args[0], args[1], args[2], args[3]);
}
