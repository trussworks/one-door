import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

import {
  ASSET_CACHE_CONTROL,
  buildManifest,
  checkImageLabels,
  contentTypeFor,
  matchesEntry,
  planUploads,
  requireEmptyDestination,
  requireReleaseInputs,
  verifyStored,
  type AssetEntry,
  type StoredObject,
} from "../../scripts/deploy/upload-assets.ts";

const parent = path.resolve(".harness/deployment-unit");
mkdirSync(parent, { recursive: true });

function staticTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(parent, "assets-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return root;
}

const stored = (entry: AssetEntry): StoredObject => ({
  ContentLength: entry.bytes,
  ChecksumSHA256: entry.sha256,
  ContentType: entry.contentType,
  CacheControl: ASSET_CACHE_CONTROL,
});

const REPOSITORY =
  "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal";
const IMAGE = `${REPOSITORY}@sha256:${"a".repeat(64)}`;
const LABELS = {
  "io.one-door.release-id": "abc123-9-1",
  "org.opencontainers.image.revision": "b".repeat(40),
};

it("refuses a bad identifier or a foreign image before any write", () => {
  expect(requireReleaseInputs(REPOSITORY, IMAGE, "abc123-9-1")).toEqual({
    digest: "sha256:" + "a".repeat(64),
  });
  for (const bad of ["../escape", "a/b", "a b", "-lead", ""])
    expect(() => requireReleaseInputs(REPOSITORY, IMAGE, bad), bad).toThrow(
      "release identifier",
    );
  expect(() =>
    requireReleaseInputs(REPOSITORY, `${REPOSITORY}:latest`, "abc123-9-1"),
  ).toThrow("digest reference");
  expect(() =>
    requireReleaseInputs(
      REPOSITORY,
      `other.example/one-door@sha256:${"a".repeat(64)}`,
      "abc123-9-1",
    ),
  ).toThrow("outside this account's repository");
});

it("refuses an image built for a different release or without a revision", () => {
  expect(checkImageLabels(LABELS, "abc123-9-1")).toEqual({
    sourceRevision: "b".repeat(40),
  });
  expect(() => checkImageLabels(LABELS, "other-9-1")).toThrow(
    "carries release abc123-9-1, not other-9-1",
  );
  expect(() => checkImageLabels(null, "abc123-9-1")).toThrow("no identifier");
  expect(() =>
    checkImageLabels(
      { ...LABELS, "org.opencontainers.image.revision": "abbreviated" },
      "abc123-9-1",
    ),
  ).toThrow("does not record a source revision");
});

it("refuses to export into a directory that already holds files", () => {
  const empty = mkdtempSync(path.join(parent, "export-"));
  expect(() => requireEmptyDestination(empty)).not.toThrow();
  expect(() =>
    requireEmptyDestination(path.join(parent, "absent-" + Date.now())),
  ).not.toThrow();
  writeFileSync(path.join(empty, "stale.js"), "from another image");
  expect(() => requireEmptyDestination(empty)).toThrow("already holds files");
});

it("keys every static file under the release namespace with its own checksum", () => {
  const root = staticTree({
    "chunks/one.js": "console.log(1)",
    "css/app.css": "a{}",
    "build-abc/_buildManifest.js": "self.__BUILD_MANIFEST={}",
  });
  const manifest = buildManifest(root, "abc123-9-1");
  expect(manifest.map((entry) => entry.key)).toEqual([
    "_assets/abc123-9-1/_next/static/build-abc/_buildManifest.js",
    "_assets/abc123-9-1/_next/static/chunks/one.js",
    "_assets/abc123-9-1/_next/static/css/app.css",
  ]);
  expect(manifest[1].sha256).toBe(
    createHash("sha256").update("console.log(1)").digest("base64"),
  );
  expect(manifest[1].bytes).toBe(14);
  expect(manifest[2].contentType).toBe("text/css; charset=utf-8");
});

it("refuses a release identifier that could escape its namespace", () => {
  const root = staticTree({ "chunks/one.js": "x" });
  for (const bad of ["../escape", "a/b", "a b", "-lead", ""])
    expect(() => buildManifest(root, bad), bad).toThrow("release identifier");
});

it("refuses an image that exported no static assets", () => {
  expect(() => buildManifest(staticTree({}), "abc123-9-1")).toThrow(
    "no static assets",
  );
});

it("labels the asset types browsers refuse to run when mislabelled", () => {
  expect(contentTypeFor("a/b.js")).toBe("text/javascript; charset=utf-8");
  expect(contentTypeFor("a/b.CSS")).toBe("text/css; charset=utf-8");
  expect(contentTypeFor("a/b.woff2")).toBe("font/woff2");
  expect(contentTypeFor("a/b.unknown")).toBe("application/octet-stream");
});

it("uploads only what is absent and never rewrites a published object", () => {
  const manifest = buildManifest(
    staticTree({ "chunks/one.js": "one", "chunks/two.js": "two" }),
    "abc123-9-1",
  );
  const partly = new Map<string, StoredObject | null>([
    [manifest[0].key, stored(manifest[0])],
    [manifest[1].key, null],
  ]);
  const plan = planUploads(manifest, partly);
  expect(plan.upload).toEqual([manifest[1]]);
  expect(plan.present).toEqual([manifest[0]]);

  for (const different of [
    { ChecksumSHA256: "different" },
    { ContentLength: 999 },
    { ContentType: "text/plain" },
    { CacheControl: "no-store" },
  ]) {
    const conflicting = new Map<string, StoredObject | null>([
      [manifest[0].key, { ...stored(manifest[0]), ...different }],
      [manifest[1].key, null],
    ]);
    expect(() => planUploads(manifest, conflicting)).toThrow(
      "refusing to overwrite",
    );
  }
});

it("treats a lost conditional-write race as published only when identical", () => {
  const [entry] = buildManifest(
    staticTree({ "chunks/one.js": "one" }),
    "abc123-9-1",
  );
  expect(matchesEntry(stored(entry), entry, ASSET_CACHE_CONTROL)).toBe(true);
  // The release record carries no cache directive, so the expected value is
  // always stated rather than defaulted.
  expect(
    matchesEntry(
      { ...stored(entry), CacheControl: undefined },
      entry,
      ASSET_CACHE_CONTROL,
    ),
  ).toBe(false);
  expect(
    matchesEntry(
      { ...stored(entry), CacheControl: undefined },
      entry,
      undefined,
    ),
  ).toBe(true);
  for (const different of [
    { ChecksumSHA256: "different" },
    { ContentLength: 999 },
    { ContentType: "text/plain" },
    { CacheControl: "no-store" },
  ])
    expect(
      matchesEntry(
        { ...stored(entry), ...different },
        entry,
        ASSET_CACHE_CONTROL,
      ),
    ).toBe(false);
});

it("confirms every published object rather than a sample", () => {
  const manifest = buildManifest(
    staticTree({ "chunks/one.js": "one", "chunks/two.js": "two" }),
    "abc123-9-1",
  );
  const complete = new Map<string, StoredObject | null>(
    manifest.map((entry) => [entry.key, stored(entry)]),
  );
  expect(() => verifyStored(manifest, complete)).not.toThrow();

  for (const [label, broken] of [
    ["missing", null],
    ["size", { ...stored(manifest[1]), ContentLength: 99 }],
    ["checksum", { ...stored(manifest[1]), ChecksumSHA256: "different" }],
    ["type", { ...stored(manifest[1]), ContentType: "text/plain" }],
    ["cache", { ...stored(manifest[1]), CacheControl: "no-store" }],
  ] as const) {
    const partial = new Map(complete);
    partial.set(manifest[1].key, broken);
    expect(() => verifyStored(manifest, partial), label).toThrow(
      manifest[1].key,
    );
  }
});
