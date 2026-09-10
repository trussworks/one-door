import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Each case spawns git, node and a stub executable; the 5s default is short.
vi.setConfig({ testTimeout: 30000 });

/** Absolute path: a command resolved through PATH could be shadowed. */
const GIT = "/usr/bin/git";
const repoRoot = new URL("..", import.meta.url).pathname;
const hooksDir = join(repoRoot, ".githooks");
const scanner = join(repoRoot, "scripts/scan-secrets.ts");
const workspaces: string[] = [];

/** Every hook name git may call through core.hooksPath. */
const HOOK_NAMES = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-rewrite",
  "pre-push",
];

/** The agent configurations that once carried recording callbacks. */
const AGENT_CONFIGS = [".codex/hooks.json", ".claude/settings.json"];

/**
 * A sandbox wired the way `npm run prepare` wires a checkout: git reads hooks
 * from .githooks, so .git/hooks is never consulted. A stub entire on PATH
 * records any call, which is how the test proves no hook makes one without
 * running the real CLI.
 */
function sandbox(install: string[] = readdirSync(hooksDir)): {
  dir: string;
  calls: () => string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "recording-hooks-"));
  workspaces.push(dir);
  execFileSync(GIT, ["init", "-q", dir]);
  execFileSync(GIT, ["config", "user.email", "hooks@test.invalid"], {
    cwd: dir,
  });
  execFileSync(GIT, ["config", "user.name", "Hooks Test"], { cwd: dir });
  mkdirSync(join(dir, ".githooks"));
  for (const name of install) {
    const target = join(dir, ".githooks", name);
    writeFileSync(
      target,
      readFileSync(join(hooksDir, name), "utf8").replace(
        /scripts\/scan-secrets\.ts/g,
        scanner,
      ),
    );
    chmodSync(target, 0o755);
  }
  execFileSync(GIT, ["config", "core.hooksPath", ".githooks"], { cwd: dir });
  const log = join(dir, "entire-calls.log");
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "bin", "entire"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexit 0\n`,
  );
  chmodSync(join(dir, "bin", "entire"), 0o755);
  return {
    dir,
    calls: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/** The stub shadows the installed entire, and node stays reachable. */
function env(dir: string) {
  return {
    ...process.env,
    PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
}

function git(dir: string, args: string[]) {
  return execFileSync(GIT, args, {
    cwd: dir,
    env: env(dir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commit(dir: string, message: string) {
  writeFileSync(join(dir, "notes.txt"), `${message}\n`);
  git(dir, ["add", "notes.txt"]);
  git(dir, ["commit", "-qm", message]);
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe("no hook records a session", () => {
  it("keeps a script for every hook name git may call", () => {
    const present = readdirSync(hooksDir);
    for (const name of HOOK_NAMES) expect(present).toContain(name);
  });

  it("calls nothing when a recorder is installed and on PATH", () => {
    const { dir, calls } = sandbox();
    commit(dir, "first");
    git(dir, ["commit", "-q", "--amend", "-m", "first amended"]);
    expect(calls()).toEqual([]);
  });

  it("names no recorder in any hook script", () => {
    for (const name of readdirSync(hooksDir))
      expect(readFileSync(join(hooksDir, name), "utf8")).not.toContain(
        "entire",
      );
  });

  it("leaves no agent callback configured", () => {
    for (const path of AGENT_CONFIGS) {
      const config = JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as {
        hooks?: Record<string, unknown[]>;
      };
      expect(Object.values(config.hooks ?? {}).flat()).toEqual([]);
    }
  });

  it("keeps the tracked recorder disabled with its redaction rules intact", () => {
    const settings = JSON.parse(
      readFileSync(join(repoRoot, ".entire/settings.json"), "utf8"),
    ) as {
      enabled: boolean;
      telemetry: boolean;
      strategy_options: { push_sessions: boolean };
      redaction: { custom_redactions: Record<string, unknown> };
    };
    expect(settings.enabled).toBe(false);
    expect(settings.telemetry).toBe(false);
    expect(settings.strategy_options.push_sessions).toBe(false);
    // Removing the callbacks must not remove the guards that redact a
    // recording made some other way.
    expect(
      Object.keys(settings.redaction.custom_redactions).length,
    ).toBeGreaterThan(0);
  });
});

describe("the gates still hold under core.hooksPath", () => {
  it("blocks a credential typed into the commit message", () => {
    const { dir, calls } = sandbox();
    commit(dir, "base");
    const value = randomBytes(12).toString("hex");
    writeFileSync(join(dir, "notes.txt"), "clean content\n");
    git(dir, ["add", "notes.txt"]);
    let blocked = false;
    let output = "";
    try {
      git(dir, ["commit", "-qm", `PASSWORD: ${value}`]);
    } catch (error) {
      const failure = error as { stdout: string; stderr: string };
      output = failure.stdout + failure.stderr;
      blocked = true;
    }
    expect(blocked).toBe(true);
    expect(output).toContain("credential-assignment");
    expect(output).not.toContain(value);
    expect(git(dir, ["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
    expect(calls()).toEqual([]);
  });

  it("still blocks a commit that stages a credential", () => {
    const { dir, calls } = sandbox();
    commit(dir, "base");
    const value = randomBytes(12).toString("hex");
    writeFileSync(join(dir, "config.yaml"), `PASSWORD: ${value}\n`);
    git(dir, ["add", "config.yaml"]);
    let blocked = false;
    let output = "";
    try {
      git(dir, ["commit", "-qm", "should not land"]);
    } catch (error) {
      const failure = error as { stdout: string; stderr: string };
      output = failure.stdout + failure.stderr;
      blocked = true;
    }
    expect(blocked).toBe(true);
    expect(output).toContain("credential-assignment");
    expect(output).not.toContain(value);
    expect(git(dir, ["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
    expect(calls()).toEqual([]);
  });
});
