import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { getFileInfo } from "prettier";
import { afterEach, expect, test } from "vitest";
import { createLocalEnvironment } from "../scripts/setup-env.ts";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "one-door-private-env-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

test("formats source and shared settings without rewriting private recorder state", async () => {
  const options = { ignorePath: ".prettierignore" };
  expect(
    (await getFileInfo(".entire/tmp/pre-prompt.json", options)).ignored,
  ).toBe(true);
  expect(
    (await getFileInfo(".entire/settings.local.json", options)).ignored,
  ).toBe(true);
  for (const path of [
    ".entire/settings.json",
    "scripts/setup-env.ts",
    "test/setup-env.test.ts",
  ])
    expect((await getFileInfo(path, options)).ignored).toBe(false);
});

test("creates private, distinct credentials that match the database URL", async () => {
  const root = await directory();
  await createLocalEnvironment(root);
  const values = parseEnv(await readFile(join(root, ".env"), "utf8"));
  assert(values.DATABASE_URL);
  const url = new URL(values.DATABASE_URL);
  expect(decodeURIComponent(url.password)).toBe(values.POSTGRES_PASSWORD);
  expect(url.username).toBe(values.POSTGRES_USER);
  expect(url.pathname).toBe("/one_door");
  expect(values.POSTGRES_PASSWORD).toMatch(/^od_db_[\da-f]{64}$/);
  expect(values.DEMO_ACCESS_CODE).toMatch(/^od_demo_[\da-f]{64}$/);
  expect(values.SESSION_SECRET).toMatch(/^od_session_[\da-f]{64}$/);
  expect(
    new Set([
      values.POSTGRES_PASSWORD,
      values.DEMO_ACCESS_CODE,
      values.SESSION_SECRET,
    ]).size,
  ).toBe(3);
  expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o600);
});

test("refuses to overwrite an existing configuration", async () => {
  const root = await directory();
  await createLocalEnvironment(root);
  const before = await readFile(join(root, ".env"));
  await expect(createLocalEnvironment(root)).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(join(root, ".env"))).toEqual(before);
});

test("preserves .env.local without creating a conflicting .env", async () => {
  const root = await directory();
  await createLocalEnvironment(root);
  await rename(join(root, ".env"), join(root, ".env.local"));
  const before = await readFile(join(root, ".env.local"));
  await expect(createLocalEnvironment(root)).rejects.toMatchObject({
    code: "EEXIST",
  });
  await expect(stat(join(root, ".env"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(root, ".env.local"))).toEqual(before);
});

test("independent setups use different values and the CLI does not print them", async () => {
  const roots = await Promise.all([directory(), directory()]);
  const script = resolve("scripts/setup-env.ts");
  const output = roots.map((cwd) =>
    spawnSync(process.execPath, ["--experimental-strip-types", script], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  for (const result of output) expect(result.status).toBe(0);
  const combined = output
    .map(({ stdout, stderr }) => stdout + stderr)
    .join("\n");
  const configs = await Promise.all(
    roots.map(async (root) =>
      parseEnv(await readFile(join(root, ".env"), "utf8")),
    ),
  );
  for (const key of [
    "POSTGRES_PASSWORD",
    "DEMO_ACCESS_CODE",
    "SESSION_SECRET",
  ]) {
    expect(configs[0][key]).not.toBe(configs[1][key]);
    for (const config of configs)
      expect(combined.includes(config[key] ?? "")).toBe(false);
  }
  expect(output.every(({ stdout }) => stdout.includes("Created .env"))).toBe(
    true,
  );
});

test("the documented npm setup command creates and preserves private configuration", async () => {
  const npm = process.env.npm_execpath;
  assert(npm, "Run this setup-command check through npm test or npx vitest.");
  await mkdir(resolve(".harness"), { recursive: true });
  const root = await mkdtemp(resolve(".harness/setup-alias-"));
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  await mkdir(join(root, "scripts"));
  for (const name of ["setup-env.ts", "is-main.mjs"])
    await copyFile(resolve("scripts", name), join(root, "scripts", name));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { "setup:env": packageJson.scripts["setup:env"] },
    }),
    { flag: "wx" },
  );
  const run = () =>
    spawnSync(process.execPath, [npm, "run", "setup:env"], {
      cwd: root,
      encoding: "utf8",
    });
  const first = run();
  expect(first.status).toBe(0);
  expect(first.stdout).toContain(
    "Created .env with private database and demo credentials.",
  );
  const before = await readFile(join(root, ".env"));
  const second = run();
  expect(second.status).toBe(1);
  expect(second.stderr).toContain(
    "Local configuration already exists; nothing was changed.",
  );
  expect(await readFile(join(root, ".env"))).toEqual(before);
  console.log("Retained setup-command fixture:", root);
});
