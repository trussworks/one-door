import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

import { isMain } from "../is-main.mjs";
import { aws } from "./aws.ts";
import { resolveAcceptableDigests } from "./verify-release.ts";

interface ImageScan {
  imageScanStatus: { status: string };
  imageScanFindings: { findingSeverityCounts?: Record<string, number> };
}

export function checkImageScan(
  repository: string,
  region: string,
  imageDigest: string,
  outputFile = "release-evidence/scans.json",
) {
  const platform = {
    repository_url: repository,
    region,
    name: repository.split("/")[1],
  };
  const digests = resolveAcceptableDigests(
    platform,
    repository + "@" + imageDigest,
  );
  const executable = digests.length > 1 ? digests.slice(1) : digests;
  const results: ImageScan[] = [];
  for (const digest of executable) {
    const args = [
      "--region",
      region,
      "--repository-name",
      platform.name,
      "--image-id",
      "imageDigest=" + digest,
    ];
    aws(["ecr", "wait", "image-scan-complete", ...args]);
    const scan = aws<ImageScan>([
      "ecr",
      "describe-image-scan-findings",
      ...args,
    ]);
    results.push(scan);
    writeFileSync(outputFile, JSON.stringify(results, null, 2) + "\n");
    assert.equal(scan.imageScanStatus.status, "COMPLETE");
    const counts = scan.imageScanFindings.findingSeverityCounts ?? {};
    console.log(JSON.stringify({ digest, findings: counts }));
    assert.equal(
      counts.CRITICAL ?? 0,
      0,
      "Critical image findings block release",
    );
    assert.equal(counts.HIGH ?? 0, 0, "High image findings block release");
  }
}

if (isMain(import.meta)) {
  const [repository, region, imageDigest, outputFile] = process.argv.slice(2);
  if (!repository || !region || !imageDigest || process.argv.length > 6)
    throw new Error(
      "Usage: check-image-scan REPOSITORY REGION IMAGE_DIGEST [OUTPUT_JSON]",
    );
  checkImageScan(repository, region, imageDigest, outputFile);
}
