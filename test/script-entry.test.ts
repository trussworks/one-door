import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { isMain } from "../scripts/is-main.mjs";

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
});

it("uses the runtime's own entry identity when available", () => {
  expect(isMain({ url: import.meta.url, main: true })).toBe(true);
  expect(isMain({ url: import.meta.url, main: false })).toBe(false);
});

it("recognizes a symlinked entry on runtimes without native entry identity", () => {
  const root = fileURLToPath(new URL("../.harness/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "entrypoint-"));
  const source = join(directory, "entry.mjs");
  const alias = join(directory, "entry-link.mjs");
  writeFileSync(source, "export {};\n");
  symlinkSync(source, alias);
  process.argv = [process.execPath, alias];
  expect(isMain({ url: pathToFileURL(realpathSync(source)).href })).toBe(true);
  expect(isMain({ url: import.meta.url })).toBe(false);
  console.log("Retained entry-point fixture:", directory);
});

it("does not execute an imported command for stdin or an absent entry", () => {
  process.argv = [process.execPath, "-"];
  expect(isMain({ url: import.meta.url })).toBe(false);
  process.argv = [process.execPath];
  expect(isMain({ url: import.meta.url })).toBe(false);
});
