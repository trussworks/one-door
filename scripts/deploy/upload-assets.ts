// Exports .next/static from the exact released image and uploads it under an
// immutable release namespace. Next.js sets a constant build id whenever
// deploymentId is configured, so per-release isolation comes from the
// /_assets/<release id> prefix, not from the build id.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  aws,
  AwsError,
  readPlatform,
  requireAccount,
  resolveTool,
  type Platform,
} from "./aws.ts";
import { isMain } from "../is-main.mjs";
import { parseImageReference } from "./verify-release.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export interface AssetEntry {
  key: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export function contentTypeFor(file: string): string {
  return (
    CONTENT_TYPES[path.extname(file).toLowerCase()] ??
    "application/octet-stream"
  );
}

export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function walk(root: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const next = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...walk(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files.sort();
}

/** One entry per static file, keyed by its final object name. */
export function buildManifest(root: string, releaseId: string): AssetEntry[] {
  if (!RELEASE_ID_PATTERN.test(releaseId))
    throw new Error(
      "The release identifier must be letters, digits and hyphens",
    );
  const files = walk(root);
  if (files.length === 0)
    throw new Error("The exported image contains no static assets");
  return files.map((file) => {
    const body = readFileSync(path.join(root, file));
    return {
      key: `_assets/${releaseId}/_next/static/${file}`,
      bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("base64"),
      contentType: contentTypeFor(file),
    };
  });
}

export interface StoredObject {
  ContentLength?: number;
  ChecksumSHA256?: string;
  ContentType?: string;
  CacheControl?: string;
}

export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * True when the stored object is byte-for-byte the entry, headers included.
 * cacheControl is required: an explicit `undefined` would otherwise fall back
 * to the default and compare the record against a directive it never carries.
 */
export function matchesEntry(
  object: StoredObject,
  entry: AssetEntry,
  cacheControl: string | undefined,
): boolean {
  return (
    object.ContentLength === entry.bytes &&
    object.ChecksumSHA256 === entry.sha256 &&
    object.ContentType === entry.contentType &&
    object.CacheControl === cacheControl
  );
}

/**
 * A retained release namespace is add-only: an identical object is already
 * published, and a different one means two releases disagree about a key that
 * old browser tabs still request.
 */
export function planUploads(
  manifest: AssetEntry[],
  stored: Map<string, StoredObject | null>,
): { upload: AssetEntry[]; present: AssetEntry[] } {
  const upload: AssetEntry[] = [];
  const present: AssetEntry[] = [];
  for (const entry of manifest) {
    const existing = stored.get(entry.key) ?? null;
    if (!existing) upload.push(entry);
    else if (matchesEntry(existing, entry, ASSET_CACHE_CONTROL))
      present.push(entry);
    else
      throw new Error(
        "A published release asset differs from this image; refusing to overwrite: " +
          entry.key,
      );
  }
  return { upload, present };
}

/** Every object is checked, because a sampled check can miss the one that broke. */
export function verifyStored(
  manifest: AssetEntry[],
  stored: Map<string, StoredObject | null>,
): void {
  for (const entry of manifest) {
    const object = stored.get(entry.key) ?? null;
    if (!object) throw new Error("Published asset is missing: " + entry.key);
    if (object.ContentLength !== entry.bytes)
      throw new Error("Published asset has the wrong size: " + entry.key);
    if (object.ChecksumSHA256 !== entry.sha256)
      throw new Error("Published asset has the wrong checksum: " + entry.key);
    if (object.ContentType !== entry.contentType)
      throw new Error(
        "Published asset has the wrong content type: " + entry.key,
      );
    if (object.CacheControl !== ASSET_CACHE_CONTROL)
      throw new Error(
        "Published asset has the wrong cache directive: " + entry.key,
      );
  }
}

/**
 * Every argument check runs before the first local or remote write, so a bad
 * release identifier or a foreign image cannot leave a half-made export
 * directory or a published object behind.
 */
export function requireReleaseInputs(
  repositoryUrl: string,
  image: string,
  releaseId: string,
): { digest: string } {
  if (!RELEASE_ID_PATTERN.test(releaseId))
    throw new Error(
      "The release identifier must be letters, digits and hyphens",
    );
  const { repository, digest } = parseImageReference(image);
  if (repository !== repositoryUrl)
    throw new Error("The release image is outside this account's repository");
  return { digest };
}

/** The image must be the one built for this release, not a neighbour. */
export function checkImageLabels(
  labels: Record<string, string> | null,
  releaseId: string,
): { sourceRevision: string } {
  const releaseLabel = labels?.["io.one-door.release-id"];
  if (releaseLabel !== releaseId)
    throw new Error(
      `The image carries release ${releaseLabel ?? "no identifier"}, not ${releaseId}`,
    );
  const sourceRevision = labels?.["org.opencontainers.image.revision"] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sourceRevision))
    throw new Error("The image does not record a source revision");
  return { sourceRevision };
}

/** A reused directory would merge another image's files into this manifest. */
export function requireEmptyDestination(destination: string): void {
  if (!existsSync(destination)) return;
  if (readdirSync(destination).length > 0)
    throw new Error(
      "The export directory already holds files; choose a new path: " +
        destination,
    );
}

function head(p: Platform, key: string): StoredObject | null {
  try {
    return aws<StoredObject>([
      "s3api",
      "head-object",
      "--region",
      p.region,
      "--bucket",
      p.assets_bucket,
      "--key",
      key,
      "--checksum-mode",
      "ENABLED",
    ]);
  } catch (error) {
    if (
      error instanceof AwsError &&
      ["404", "NoSuchKey", "NotFound"].includes(error.code)
    )
      return null;
    throw error;
  }
}

function headAll(p: Platform, manifest: AssetEntry[]) {
  return new Map(manifest.map((entry) => [entry.key, head(p, entry.key)]));
}

function imageLabels(image: string): Record<string, string> | null {
  const output = execFileSync(
    resolveTool("docker"),
    ["image", "inspect", "--format", "{{json .Config.Labels}}", image],
    { encoding: "utf8" },
  ).trim();
  return JSON.parse(output) as Record<string, string> | null;
}

/**
 * Copies the static directory out of the exact image. The export container is
 * retained, not removed: cleanup of anything is an explicit operator decision.
 */
export function exportStatic(image: string, destination: string): string {
  requireEmptyDestination(destination);
  const docker = resolveTool("docker");
  const container = execFileSync(
    docker,
    ["create", "--label", "one-door-asset-export=true", image],
    { encoding: "utf8" },
  ).trim();
  mkdirSync(destination, { recursive: true });
  execFileSync(docker, ["cp", `${container}:/app/.next/static/.`, destination]);
  console.log("Export container retained for inspection:", container);
  return container;
}

/**
 * S3 conditional create. Between the check and the write another runner could
 * publish the same key, so a lost race is resolved by reading the winner and
 * accepting it only when its content and headers are identical.
 */
function putIfAbsent(
  p: Platform,
  entry: AssetEntry,
  body: string,
  cacheControl?: string,
): "created" | "already-published" {
  try {
    aws([
      "s3api",
      "put-object",
      "--region",
      p.region,
      "--bucket",
      p.assets_bucket,
      "--key",
      entry.key,
      "--body",
      body,
      "--content-type",
      entry.contentType,
      "--checksum-algorithm",
      "SHA256",
      "--if-none-match",
      "*",
      ...(cacheControl ? ["--cache-control", cacheControl] : []),
    ]);
    return "created";
  } catch (error) {
    if (
      !(error instanceof AwsError) ||
      !["PreconditionFailed", "412", "ConditionalRequestConflict"].includes(
        error.code,
      )
    )
      throw error;
    const winner = head(p, entry.key);
    if (!winner || !matchesEntry(winner, entry, cacheControl))
      throw new Error(
        "Another writer published different content for: " + entry.key,
        { cause: error },
      );
    return "already-published";
  }
}

if (isMain(import.meta)) {
  const [platformFile, image, releaseId] = process.argv.slice(2);
  if (!platformFile || !image || !releaseId)
    throw new Error(
      "Usage: upload-assets.ts PLATFORM_JSON IMAGE_DIGEST_REFERENCE RELEASE_ID",
    );
  const p = readPlatform(platformFile);
  // Everything that can refuse the run happens before the first write.
  requireReleaseInputs(p.repository_url, image, releaseId);
  requireAccount(p);
  const { sourceRevision } = checkImageLabels(imageLabels(image), releaseId);
  const parent = path.resolve(".harness/asset-export");
  mkdirSync(parent, { recursive: true });
  const runDirectory = mkdtempSync(path.join(parent, releaseId + "-"));
  const destination = path.join(runDirectory, "static");
  exportStatic(image, destination);
  const manifest = buildManifest(destination, releaseId);
  const { upload, present } = planUploads(manifest, headAll(p, manifest));
  let raced = 0;
  for (const entry of upload) {
    const outcome = putIfAbsent(
      p,
      entry,
      path.join(destination, entry.key.split("/_next/static/")[1]),
      ASSET_CACHE_CONTROL,
    );
    if (outcome === "already-published") raced += 1;
  }
  verifyStored(manifest, headAll(p, manifest));

  const record = {
    releaseId,
    image,
    sourceRevision,
    objects: manifest.length,
    bytes: manifest.reduce((total, entry) => total + entry.bytes, 0),
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    entries: manifest,
  };
  const body = JSON.stringify(record);
  const recordFile = path.join(runDirectory, "assets.json");
  writeFileSync(recordFile, body, { flag: "w" });
  const recordEntry: AssetEntry = {
    key: `release-records/${releaseId}/assets.json`,
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("base64"),
    contentType: "application/json",
  };
  // The record is add-only too: a second run of the same release must not
  // replace the record the first run published.
  const existingRecord = head(p, recordEntry.key);
  if (existingRecord && !matchesEntry(existingRecord, recordEntry, undefined))
    throw new Error(
      "A different asset record is already published for release " + releaseId,
    );
  if (!existingRecord) putIfAbsent(p, recordEntry, recordFile);
  const storedRecord = head(p, recordEntry.key);
  if (!storedRecord || !matchesEntry(storedRecord, recordEntry, undefined))
    throw new Error("The asset record was not persisted as written");

  console.log(
    JSON.stringify({
      releaseId,
      sourceRevision,
      uploaded: upload.length - raced,
      alreadyPublished: present.length + raced,
      objects: manifest.length,
      manifestSha256: record.manifestSha256,
    }),
  );
  console.log("Release assets published and verified.");
}
