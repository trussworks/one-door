import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { isMain } from "../is-main.mjs";
import { buildRecord } from "./release-record.ts";
import { buildManifest, exportStatic } from "./upload-assets.ts";

export function captureRelease(
  image: string,
  releaseId: string,
  sourceRevision: string,
) {
  exportStatic(image, "release-evidence/static");
  const entries = buildManifest("release-evidence/static", releaseId);
  const assetsManifestSha256 = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  writeFileSync(
    "release-evidence/assets.json",
    JSON.stringify({ entries, assetsManifestSha256 }, null, 2) + "\n",
  );
  const record = buildRecord({
    releaseId,
    sourceRevision,
    image,
    assetsManifestSha256,
    migrationsDirectory: "migrations",
  });
  writeFileSync(
    "release-evidence/release.json",
    JSON.stringify(record, null, 2) + "\n",
  );
}

if (isMain(import.meta)) {
  const [image, releaseId, sourceRevision] = process.argv.slice(2);
  if (!image || !releaseId || !sourceRevision)
    throw new Error("Usage: capture-release IMAGE RELEASE_ID SOURCE_REVISION");
  captureRelease(image, releaseId, sourceRevision);
}
