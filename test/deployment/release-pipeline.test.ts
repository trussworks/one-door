import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  exportStatic: vi.fn(),
  buildManifest: vi.fn(),
  buildRecord: vi.fn(),
  resolveAcceptableDigests: vi.fn(),
  aws: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: mocks.writeFileSync,
}));
vi.mock("../../scripts/deploy/upload-assets.ts", () => ({
  exportStatic: mocks.exportStatic,
  buildManifest: mocks.buildManifest,
}));
vi.mock("../../scripts/deploy/release-record.ts", () => ({
  buildRecord: mocks.buildRecord,
}));
vi.mock("../../scripts/deploy/verify-release.ts", () => ({
  resolveAcceptableDigests: mocks.resolveAcceptableDigests,
}));
vi.mock("../../scripts/deploy/aws.ts", () => ({ aws: mocks.aws }));

import { captureRelease } from "../../scripts/deploy/capture-release.ts";
import { checkImageScan } from "../../scripts/deploy/check-image-scan.ts";

const repository =
  "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal";
const index = "sha256:" + "a".repeat(64);
const child = "sha256:" + "b".repeat(64);
const image = repository + "@" + index;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

it.each(["capture-release", "check-image-scan"])(
  "%s refuses missing command arguments",
  (name) => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(
          new URL(`../../scripts/deploy/${name}.ts`, import.meta.url),
        ),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: " + name);
    expect(result.stdout).toBe("");
  },
);

it("captures the exact image assets and hashes the manifest used in the release record", () => {
  const entries = [
    { key: "_assets/release-1/_next/static/main.js", bytes: 12 },
  ];
  const digest = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  mocks.buildManifest.mockReturnValue(entries);
  mocks.buildRecord.mockReturnValue({ image, assetsManifestSha256: digest });
  captureRelease(image, "release-1", "c".repeat(40));
  expect(mocks.exportStatic).toHaveBeenCalledWith(
    image,
    "release-evidence/static",
  );
  expect(mocks.buildManifest).toHaveBeenCalledWith(
    "release-evidence/static",
    "release-1",
  );
  expect(mocks.buildRecord).toHaveBeenCalledWith({
    image,
    releaseId: "release-1",
    sourceRevision: "c".repeat(40),
    assetsManifestSha256: digest,
    migrationsDirectory: "migrations",
  });
  const writes = mocks.writeFileSync.mock.calls;
  expect(writes.map(([path]) => path)).toEqual([
    "release-evidence/assets.json",
    "release-evidence/release.json",
  ]);
  expect(JSON.parse(writes[0][1])).toEqual({
    entries,
    assetsManifestSha256: digest,
  });
  expect(JSON.parse(writes[1][1])).toEqual({
    image,
    assetsManifestSha256: digest,
  });
  expect(mocks.exportStatic.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.buildManifest.mock.invocationCallOrder[0],
  );
});

it("does not write release evidence when image extraction fails", () => {
  mocks.exportStatic.mockImplementation(() => {
    throw new Error("export failed");
  });
  expect(() => captureRelease(image, "release-1", "c".repeat(40))).toThrow(
    "export failed",
  );
  expect(mocks.buildManifest).not.toHaveBeenCalled();
  expect(mocks.writeFileSync).not.toHaveBeenCalled();
});

it.each([[index], [index, child]])(
  "waits for scans of executable digests: %j",
  (...digests) => {
    mocks.resolveAcceptableDigests.mockReturnValue(digests);
    mocks.aws.mockReturnValue({
      imageScanStatus: { status: "COMPLETE" },
      imageScanFindings: {},
    });
    checkImageScan(repository, "us-west-2", index);
    expect(mocks.resolveAcceptableDigests).toHaveBeenCalledWith(
      {
        repository_url: repository,
        region: "us-west-2",
        name: "one-door-personal",
      },
      image,
    );
    const args = [
      "--region",
      "us-west-2",
      "--repository-name",
      "one-door-personal",
      "--image-id",
      "imageDigest=" + digests.at(-1),
    ];
    expect(mocks.aws.mock.calls).toEqual([
      [["ecr", "wait", "image-scan-complete", ...args]],
      [["ecr", "describe-image-scan-findings", ...args]],
    ]);
    expect(mocks.writeFileSync).toHaveBeenCalledOnce();
  },
);

it.each([
  ["IN_PROGRESS", {}, "COMPLETE"],
  ["COMPLETE", { CRITICAL: 1 }, "Critical image findings block release"],
  ["COMPLETE", { HIGH: 1 }, "High image findings block release"],
])(
  "preserves failed scan evidence before rejecting %s %j",
  (status, counts, message) => {
    mocks.resolveAcceptableDigests.mockReturnValue([
      index,
      child,
      "sha256:" + "d".repeat(64),
    ]);
    const scan = {
      imageScanStatus: { status },
      imageScanFindings: { findingSeverityCounts: counts },
    };
    mocks.aws.mockReturnValue(scan);
    expect(() => checkImageScan(repository, "us-west-2", index)).toThrow(
      message,
    );
    expect(JSON.parse(mocks.writeFileSync.mock.calls[0][1])).toEqual([scan]);
    expect(mocks.aws).toHaveBeenCalledTimes(2);
  },
);
