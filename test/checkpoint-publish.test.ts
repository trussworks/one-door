import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Each case spawns git and node; parallel runs exceed the 5s default.
vi.setConfig({ testTimeout: 30000 });

/** Absolute path: a command resolved through PATH could be shadowed. */
const GIT = "/usr/bin/git";
const repoRoot = new URL("..", import.meta.url).pathname;
const workspaces: string[] = [];

function secret(): string {
  return randomBytes(12).toString("hex");
}

/** A sandbox holding the publisher, the scanner, and a bare remote. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
  const remote = mkdtempSync(join(tmpdir(), "checkpoint-remote-"));
  workspaces.push(dir, remote);
  execFileSync(GIT, ["init", "-q", "--bare", remote]);
  execFileSync(GIT, ["init", "-q", dir]);
  execFileSync(GIT, ["config", "user.email", "cp@test.invalid"], { cwd: dir });
  execFileSync(GIT, ["config", "user.name", "Checkpoint Test"], { cwd: dir });
  execFileSync(GIT, ["remote", "add", "origin", remote], { cwd: dir });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const file of [
    "scan-secrets.ts",
    "publish-checkpoints.ts",
    "is-main.mjs",
  ])
    cpSync(join(repoRoot, "scripts", file), join(dir, "scripts", file));
  // The scanner resolves the engine and its configuration from its own tree,
  // so the sandbox has to be an installed tree or every publish fails closed.
  cpSync(join(repoRoot, ".secretlintrc.json"), join(dir, ".secretlintrc.json"));
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(join(dir, "readme.txt"), "base\n");
  execFileSync(GIT, ["add", "-A"], { cwd: dir });
  execFileSync(GIT, ["commit", "-qm", "base"], { cwd: dir });
  execFileSync(GIT, ["push", "-q", "origin", "HEAD:refs/heads/main"], {
    cwd: dir,
  });
  return { dir, remote };
}

/** Record a checkpoint the way Entire does: a commit on a checkpoint ref. */
function checkpoint(dir: string, name: string, body: string) {
  writeFileSync(join(dir, "cfg.yaml"), body);
  execFileSync(GIT, ["add", "-A"], { cwd: dir });
  execFileSync(GIT, ["commit", "-qm", name], { cwd: dir });
  execFileSync(
    GIT,
    ["update-ref", `refs/entire/checkpoints/aa/${name}`, "HEAD"],
    { cwd: dir },
  );
}

function publish(dir: string) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/publish-checkpoints.ts",
        "origin",
      ],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: failure.stdout + failure.stderr };
  }
}

function remoteCheckpoints(remote: string) {
  return execFileSync(
    GIT,
    [
      "--git-dir",
      remote,
      "for-each-ref",
      "--format=%(refname)",
      "refs/entire/checkpoints",
    ],
    { encoding: "utf8" },
  );
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe("guarded checkpoint publication", () => {
  it("does not treat another remote's history as already safe for the destination", () => {
    const { dir, remote } = sandbox();
    checkpoint(dir, "other-remote", `PASSWORD: ${secret()}\n`);
    execFileSync(GIT, ["update-ref", "refs/remotes/unrelated/main", "HEAD"], {
      cwd: dir,
    });
    const result = publish(dir);
    expect(result.code).toBe(1);
    expect(remoteCheckpoints(remote)).toBe("");
  });

  it("accepts and publishes a clean checkpoint, then confirms the remote holds it", () => {
    const { dir, remote } = sandbox();
    checkpoint(dir, "clean", "PASSWORD: ${DB_PASSWORD}\n");
    const result = publish(dir);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Published 1 checkpoint");
    expect(remoteCheckpoints(remote)).toContain(
      "refs/entire/checkpoints/aa/clean",
    );
  });

  it("rejects a checkpoint carrying a credential and leaves the remote untouched", () => {
    const { dir, remote } = sandbox();
    const value = secret();
    checkpoint(dir, "dirty", `PASSWORD: ${value}\n`);
    const result = publish(dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Checkpoint publication refused");
    expect(result.output).toContain("credential-assignment");
    expect(result.output).not.toContain(value);
    expect(remoteCheckpoints(remote)).not.toContain("refs/entire/checkpoints");
  });
});
