import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";

it("runs the native compiler while retaining the compiler API for analysis tools", () => {
  const compiler = resolve("node_modules/.bin/tsc");
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  expect(version.status).toBe(0);
  expect(version.stdout).toMatch(/^Version 7\./);
  expect(
    ts.createSourceFile("probe.ts", "const value = 1;", ts.ScriptTarget.Latest)
      .statements,
  ).toHaveLength(1);
  const directory = mkdtempSync(join(tmpdir(), "one-door-typecheck-"));
  try {
    const check = (source: string) => {
      writeFileSync(join(directory, "probe.ts"), source);
      return spawnSync(compiler, ["--strict", "--noEmit", "probe.ts"], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
      });
    };
    expect(check("const value: number = 1;").status).toBe(0);
    const rejected = check('const value: number = "wrong type";');
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toContain("TS2322");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
