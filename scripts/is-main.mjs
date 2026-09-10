import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isMain(meta) {
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
