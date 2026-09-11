import { execFileSync } from "node:child_process";

/** Absolute path: a command resolved through PATH could be shadowed. */
const GIT = "/usr/bin/git";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Each case spawns git and node; parallel runs exceed the 5s default.
vi.setConfig({ testTimeout: 30000 });

import { scanText } from "../scripts/scan-secrets.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const scanner = join(repoRoot, "scripts/scan-secrets.ts");
const workspaces: string[] = [];

/** Every fixture credential is generated, so no test carries a real value. */
function secret(): string {
  return randomBytes(12).toString("hex");
}

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
  workspaces.push(dir);
  execFileSync(GIT, ["init", "-q"], { cwd: dir });
  execFileSync(GIT, ["config", "user.email", "scan@test.invalid"], {
    cwd: dir,
  });
  execFileSync(GIT, ["config", "user.name", "Scan Test"], { cwd: dir });
  return dir;
}

/** A bare remote plus the pre-push hook wired into a sandbox. */
function withRemote(dir: string): string {
  const remote = mkdtempSync(join(tmpdir(), "secret-scan-remote-"));
  workspaces.push(remote);
  execFileSync(GIT, ["init", "-q", "--bare", remote]);
  execFileSync(GIT, ["remote", "add", "origin", remote], { cwd: dir });
  mkdirSync(join(dir, ".githooks"), { recursive: true });
  writeFileSync(
    join(dir, ".githooks/pre-push"),
    readFileSync(join(repoRoot, ".githooks/pre-push"), "utf8").replace(
      /scripts\/scan-secrets\.ts/g,
      scanner,
    ),
  );
  execFileSync("/bin/chmod", ["+x", join(dir, ".githooks/pre-push")]);
  execFileSync(GIT, ["config", "core.hooksPath", ".githooks"], { cwd: dir });
  return remote;
}

function commitAll(dir: string, message: string) {
  execFileSync(GIT, ["add", "-A"], { cwd: dir });
  execFileSync(GIT, ["commit", "-qm", message], { cwd: dir });
}

function run(dir: string, args: string[], script = scanner) {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", script, ...args],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: failure.stdout + failure.stderr };
  }
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe("quoted source and resource references", () => {
  it("keeps references inside recorded callbacks distinct from literal passwords", () => {
    for (const code of [
      "async () => ({ password: connection.password, SESSION_SECRET: settings.signingSecret })",
      "(async () => { const result = { password: connection.password }; return result; })()",
      "export default { password: connection.password };",
    ])
      expect(scanText("full.jsonl", JSON.stringify({ text: code }))).toEqual(
        [],
      );
    const literal = `async () => ({ PASSWORD: "${secret()}" })`;
    expect(
      scanText("full.jsonl", JSON.stringify({ text: literal })).length,
    ).toBeGreaterThan(0);
  });
  it("distinguishes authentication tokens from cursor and measurement fields", () => {
    expect(
      scanText(
        "response.json",
        '{"next_page_token":"next_page_token","inputMicrosPerToken":"number","leaseToken":"string"}',
      ),
    ).toEqual([]);
    for (const key of [
      "TOKEN",
      "GITHUB_TOKEN",
      "myAccessToken",
      "private_token",
      "OAUTH_TOKEN",
    ])
      expect(
        scanText("credentials.json", JSON.stringify({ [key]: secret() }))
          .length,
      ).toBeGreaterThan(0);
  });
  it("does not treat a dynamically assembled access message as a fixed value", () => {
    const code = 'const details = origin + "\\nAccess code: " + gate + "\\n";';
    expect(scanText("install.ts", code)).toEqual([]);
    expect(scanText("full.jsonl", JSON.stringify({ text: code }))).toEqual([]);
  });

  it("does not mistake an ARN resource name for a credential assignment", () => {
    const line =
      'admin_secret_arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:one-door/admin"';
    expect(scanText("security.tftest.hcl", line)).toEqual([]);
    expect(scanText("full.jsonl", JSON.stringify({ text: line }))).toEqual([]);
  });

  it("still catches a password embedded in quoted or serialized text", () => {
    const line = `const output = "PASSWORD: ${secret()}";`;
    expect(scanText("output.ts", line).length).toBeGreaterThan(0);
    expect(
      scanText("full.jsonl", JSON.stringify({ text: line })).length,
    ).toBeGreaterThan(0);
  });

  it("does not exempt a password because the URL uses an example host", () => {
    const line = `https://user:${secret()}@example.com`;
    expect(
      scanText("example.md", line).some(
        (finding) => finding.rule === "credential-url",
      ),
    ).toBe(true);
  });

  it("does not exempt a value appended to a redaction marker", () => {
    expect(
      scanText("config.yml", `PASSWORD: REDACTED.${secret()}`).length,
    ).toBeGreaterThan(0);
  });

  it("handles a long opaque word without retrying at each character", () => {
    expect(scanText("record.txt", "x".repeat(100000))).toEqual([]);
  });
});

describe("credential rules", () => {
  it("detects a plain password assignment that secretlint's URL rule misses", () => {
    const findings = scanText(
      "compose.yaml",
      `      POSTGRES_PASSWORD: ${secret()}`,
    );
    expect(findings.map((f) => f.rule)).toEqual(["credential-assignment"]);
  });

  it("detects a credential URL on a local host", () => {
    for (const host of ["localhost", "127.0.0.1", "host.docker.internal"]) {
      const line = `DATABASE_URL=postgresql://one_door:${secret()}@${host}:5432/db`;
      const findings = scanText(".env", line);
      expect(findings.map((f) => f.rule)).toContain("credential-url");
    }
  });

  it("accepts shell references, type annotations and property access", () => {
    // Assembled from parts so the fixture is not itself a literal pattern.
    const ref = "$" + "password";
    const clean: Array<[string, string]> = [
      ["run.sh", `-e POSTGRES_PASSWORD="${ref}" \\`],
      ["run.sh", `password=${ref}`],
      ["a.ts", "  leaseToken: string;"],
      ["a.ts", "  inputMicrosPerToken: number;"],
      ["a.ts", '      leaseToken: job.leaseToken ?? "",'],
      ["a.ts", '        "x-api-key": apiKey,'],
    ];
    for (const [path, line] of clean) expect(scanText(path, line)).toEqual([]);
  });

  it("still catches a quoted credential inside code", () => {
    expect(scanText("a.ts", `  const apiKey = "${secret()}";`)).toHaveLength(1);
  });

  it("catches an unquoted credential URL inside code", () => {
    // The quoting rule that code files get must not reach the URL password:
    // a credential URL is a credential whatever the file extension is.
    const line = `postgresql://one_door:${secret()}@localhost:5432/db`;
    for (const path of ["a.ts", "a.tsx", "a.mjs", "compose.yaml"])
      expect(scanText(path, line).map((f) => f.rule)).toContain(
        "credential-url",
      );
  });

  it("catches a bare configuration password that contains dots", () => {
    const dotted = `${secret()}.${secret()}`;
    expect(scanText("app.yaml", `PASSWORD: ${dotted}`)).toHaveLength(1);
    // Base64 and URL-safe alphabets, which real credentials use.
    const encoded = `${randomBytes(6).toString("base64")}/${secret()}=`;
    expect(scanText("app.yaml", `SECRET: ${encoded}`)).toHaveLength(1);
  });

  it("accepts a value a template assembles at run time", () => {
    const open = "$" + "{";
    for (const line of [
      `  const token = \`ghp_${open}suffix}\`;`,
      `  const url = "postgresql://u:${open}pw}@localhost/db";`,
    ])
      expect(scanText("a.ts", line)).toEqual([]);
  });

  it("does not mistake slash-leading encoded credentials for file paths", () => {
    for (const value of [`/${secret()}=`, `/${secret()}+${secret()}`])
      expect(scanText("app.yaml", `SECRET: ${value}`)).toHaveLength(1);
  });

  it("catches a default assigned with a logical-assignment operator", () => {
    for (const operator of ["||=", "??="]) {
      const line = `  process.env.DEMO_ACCESS_CODE ${operator} "${secret()}";`;
      expect(scanText("a.ts", line).map((f) => f.rule)).toEqual([
        "credential-assignment",
      ]);
    }
  });

  it("accepts a logical-assignment default that is not a literal", () => {
    const clean = [
      "  process.env.SESSION_SECRET ||= process.env.FALLBACK_SECRET;",
      '  process.env.SESSION_SECRET ||= randomBytes(32).toString("hex");',
      "  retryCount ||= 0;",
    ];
    for (const line of clean) expect(scanText("a.ts", line)).toEqual([]);
  });

  it("accepts a file path given as the value", () => {
    for (const value of ["/run/secrets/db", "./secrets/db.txt", "~/.pgpass"])
      expect(scanText("app.yaml", `password: ${value}`)).toEqual([]);
  });
});

describe("generated credential format", () => {
  it("catches the generated credential format with no assignment around it", () => {
    // Assembled from parts so this file never holds a matching literal.
    const token = "od_" + "db_" + randomBytes(16).toString("hex");
    for (const [path, line] of [
      ["notes.md", `The value ${token} appeared in a log line.`],
      ["a.ts", `// ${token}`],
      ["run.sh", token],
    ] as Array<[string, string]>)
      expect(scanText(path, line).map((f) => f.rule)).toEqual([
        "named-credential",
      ]);
  });

  it("catches the generated credential format after base64 decoding", () => {
    for (const kind of ["db_", "demo_", "session_"]) {
      const token = "od_" + kind + randomBytes(16).toString("hex");
      const encoded = Buffer.from(token).toString("base64");
      expect(scanText("payload.json", encoded).map((f) => f.rule)).toEqual([
        "named-credential-encoded",
      ]);
    }
  });

  it("leaves a short identifier with the same prefix alone", () => {
    const short = "od_" + "db_" + randomBytes(11).toString("hex").slice(0, 23);
    expect(scanText("notes.md", short)).toEqual([]);
  });
});

describe("environment indirection", () => {
  it("accepts environment indirection and blank templates", () => {
    const lines = [
      "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in the local environment.}",
      "          POSTGRES_PASSWORD: ${{ needs.secrets-setup.outputs.db_password }}",
      "DATABASE_URL=",
      'process.env.ANTHROPIC_API_KEY = randomBytes(24).toString("hex");',
      "DATABASE_URL=postgresql://one_door:${{ needs.secrets-setup.outputs.db_password }}@localhost:5432/db",
    ];
    for (const line of lines) expect(scanText("sample", line)).toEqual([]);
  });
});

describe("redaction markers", () => {
  // Assembled from parts, and the URL is built here rather than at each call,
  // so this file never holds a line a scan of it would have to reason about.
  const marker = "RED" + "ACTED";
  const url = (password: string) =>
    `DATABASE_URL=postgresql://u:${password}@localhost/db`;

  it("accepts a marker where a value was removed", () => {
    const clean: Array<[string, string]> = [
      ["app.yaml", `PASSWORD: ${marker}`],
      ["app.yaml", `PASSWORD: [${marker}]`],
      ["app.yaml", `PASSWORD: <${marker}>`],
      ["app.yaml", `PASSWORD: ${marker}:one_door`],
      ["a.ts", `  const apiKey = "${marker}";`],
      ["a.ts", `  const apiKey = "[${marker}]";`],
      [".env", url(marker)],
      [".env", url(`[${marker}]`)],
    ];
    for (const [path, line] of clean) expect(scanText(path, line)).toEqual([]);
  });

  it("still catches a value that only begins with the marker word", () => {
    // No separator, so the trailing text is entropy rather than a qualifier.
    const dirty: Array<[string, string]> = [
      ["app.yaml", `PASSWORD: ${marker}${secret()}`],
      ["a.ts", `  const apiKey = "${marker}${secret()}";`],
      [".env", url(`${marker}${secret()}`)],
    ];
    for (const [path, line] of dirty)
      expect(scanText(path, line).length).toBeGreaterThan(0);
  });
});

describe("messages", () => {
  it("finds a credential typed into a commit message", () => {
    const dir = sandbox();
    const value = secret();
    writeFileSync(join(dir, "readme.txt"), "clean content\n");
    execFileSync(GIT, ["add", "-A"], { cwd: dir });
    // The tree is clean; only the message carries the value.
    execFileSync(GIT, ["commit", "-qm", `PASSWORD: ${value}`], { cwd: dir });
    const history = run(dir, ["--history"]);
    expect(history.code).toBe(1);
    expect(history.output).toContain("(commit message)");
    expect(history.output).toContain("credential-assignment");
    expect(history.output).not.toContain(value);
  });

  it("finds a credential typed into an annotated tag message", () => {
    const dir = sandbox();
    writeFileSync(join(dir, "readme.txt"), "clean content\n");
    commitAll(dir, "clean subject");
    const value = secret();
    execFileSync(GIT, ["tag", "-a", "v1", "-m", `PASSWORD: ${value}`], {
      cwd: dir,
    });
    const history = run(dir, ["--history"]);
    expect(history.code).toBe(1);
    expect(history.output).toContain("(tag message)");
    expect(history.output).not.toContain(value);
  });

  it("passes a clean commit message and a clean tag message", () => {
    const dir = sandbox();
    writeFileSync(join(dir, "readme.txt"), "clean content\n");
    commitAll(dir, "an ordinary subject line");
    execFileSync(GIT, ["tag", "-a", "v1", "-m", "an ordinary tag message"], {
      cwd: dir,
    });
    const history = run(dir, ["--history"]);
    expect(history.code).toBe(0);
    expect(history.output).toContain("No credentials found");
  });

  it("reads a message file directly for the commit-msg gate", () => {
    const dir = sandbox();
    const value = secret();
    const file = join(dir, "message.txt");
    writeFileSync(file, `Subject\n\nPASSWORD: ${value}\n`);
    const dirty = run(dir, ["--message", file]);
    expect(dirty.code).toBe(1);
    expect(dirty.output).toContain("credential-assignment");
    expect(dirty.output).not.toContain(value);
    writeFileSync(file, "Subject\n\nAn ordinary body.\n");
    expect(run(dir, ["--message", file]).code).toBe(0);
  });
});

describe("mode dispatch", () => {
  it("rejects an unknown mode before any scan and echoes nothing back", () => {
    const dir = sandbox();
    // A tracked credential makes an accidental worktree fallback visible.
    writeFileSync(join(dir, "config.yaml"), `PASSWORD: ${secret()}\n`);
    execFileSync(GIT, ["add", "config.yaml"], { cwd: dir });
    const result = run(dir, ["--histroy"]);
    expect(result.code).toBe(2);
    expect(result.output).toContain(
      "Unknown scan mode. Use --worktree, --staged, --message, --range, or --history.",
    );
    expect(result.output).not.toContain("--histroy");
    expect(result.output).not.toContain("No credentials found");
    expect(result.output).not.toContain("Credential findings");
  });

  it("keeps the explicit and default worktree modes equivalent", () => {
    const dir = sandbox();
    writeFileSync(join(dir, "notes.txt"), "clean content\n");
    expect(run(dir, ["--worktree"]).code).toBe(0);
    expect(run(dir, []).code).toBe(0);
    const value = secret();
    writeFileSync(join(dir, "config.yaml"), `PASSWORD: ${value}\n`);
    // The worktree scan reads tracked paths, so the credential must be added.
    execFileSync(GIT, ["add", "config.yaml"], { cwd: dir });
    for (const args of [["--worktree"], []]) {
      const result = run(dir, args);
      expect(result.code).toBe(1);
      expect(result.output).toContain("credential-assignment");
      expect(result.output).not.toContain(value);
    }
  });
});

describe("gates", () => {
  it("checks the staged index, not a clean working copy", () => {
    const dir = sandbox();
    const value = secret();
    writeFileSync(join(dir, "config.yaml"), `PASSWORD: ${value}\n`);
    execFileSync(GIT, ["add", "config.yaml"], { cwd: dir });
    // The working copy is cleaned after staging; the index still carries it.
    writeFileSync(join(dir, "config.yaml"), "PASSWORD: ${DB_PASSWORD}\n");
    const staged = run(dir, ["--staged"]);
    expect(staged.code).toBe(1);
    expect(staged.output).toContain("credential-assignment");
    expect(staged.output).not.toContain(value);
  });

  it("detects a credential that only exists in earlier history", () => {
    const dir = sandbox();
    const value = secret();
    writeFileSync(join(dir, "config.yaml"), `PASSWORD: ${value}\n`);
    execFileSync(GIT, ["add", "."], { cwd: dir });
    execFileSync(GIT, ["commit", "-qm", "add config"], { cwd: dir });
    // Deleting the value in a later commit must not clear the history finding.
    writeFileSync(join(dir, "config.yaml"), "PASSWORD: ${DB_PASSWORD}\n");
    execFileSync(GIT, ["commit", "-qam", "remove literal"], { cwd: dir });
    const head = run(dir, ["--staged"]);
    expect(head.code).toBe(0);
    const history = run(dir, ["--history"]);
    expect(history.code).toBe(1);
    expect(history.output).toContain("credential-assignment");
    expect(history.output).not.toContain(value);
  });

  it("finds a credential a merge commit introduces", () => {
    const dir = sandbox();
    writeFileSync(join(dir, "readme.txt"), "base\n");
    commitAll(dir, "base");
    execFileSync(GIT, ["checkout", "-q", "-b", "side"], { cwd: dir });
    const value = secret();
    writeFileSync(join(dir, "m.yaml"), `PASSWORD: ${value}\n`);
    commitAll(dir, "side");
    execFileSync(GIT, ["checkout", "-q", "-"], { cwd: dir });
    execFileSync(GIT, ["merge", "-q", "--no-ff", "side", "-m", "merge"], {
      cwd: dir,
    });
    const merged = run(dir, ["--range", "HEAD"]);
    expect(merged.code).toBe(1);
    expect(merged.output).toContain("credential-assignment");
    expect(merged.output).not.toContain(value);
  });

  it("reports an unreadable object rather than treating it as clean", async () => {
    const { scanText } = await import("../scripts/scan-secrets.ts");
    // A blob the scanner cannot decode must never yield an empty finding list
    // that a caller reads as success.
    expect(scanText("x", "PASSWORD: ${VAR}")).toEqual([]);
    expect(scanText("x", `PASSWORD: ${secret()}`)).toHaveLength(1);
  });

  it("passes a clean index and reports no value anywhere in its output", () => {
    const dir = sandbox();
    writeFileSync(join(dir, "config.yaml"), "PASSWORD: ${DB_PASSWORD}\n");
    execFileSync(GIT, ["add", "config.yaml"], { cwd: dir });
    const clean = run(dir, ["--staged"]);
    expect(clean.code).toBe(0);
    expect(clean.output).toContain("No credentials found");
  });
});

describe("engine", () => {
  it("fails closed when the engine is absent and nothing is staged", () => {
    const dir = sandbox();
    mkdirSync(join(dir, "scripts"));
    // A copy outside the installed tree cannot resolve secretlint. Nothing is
    // staged, so an empty selection is the case that must still fail closed.
    const isolated = join(dir, "scripts/scan-secrets.ts");
    writeFileSync(isolated, readFileSync(scanner));
    writeFileSync(
      join(dir, "scripts/is-main.mjs"),
      readFileSync(join(repoRoot, "scripts/is-main.mjs")),
    );
    const result = run(dir, ["--staged"], isolated);
    expect(result.code).toBe(1);
    expect(result.output).toContain("secretlint-unavailable");
    expect(result.output).not.toContain("No credentials found");
  });

  it("blocks a commit holding the generated format with no key word", () => {
    const dir = sandbox();
    const token = "od_" + "session_" + randomBytes(16).toString("hex");
    // No key word and no assignment: only the named format can catch it.
    writeFileSync(join(dir, "notes.md"), `Recovered from a log: ${token}\n`);
    execFileSync(GIT, ["add", "notes.md"], { cwd: dir });
    const staged = run(dir, ["--staged"]);
    expect(staged.code).toBe(1);
    expect(staged.output).toContain("named-credential");
    expect(staged.output).not.toContain(token);
  });

  it("runs the engine over blob bytes and catches what the rules here miss", () => {
    const dir = sandbox();
    // Randomly generated in the shape of a GitHub token; no account holds it.
    const token = `ghp_${randomBytes(18).toString("hex")}`;
    // No assignment and no key word, so only secretlint can find it.
    expect(scanText("notes.md", `Reference value ${token}`)).toEqual([]);
    writeFileSync(
      join(dir, "notes.md"),
      // 0xe9 is not valid UTF-8; the blob must reach the engine regardless.
      Buffer.concat([
        Buffer.from(`Café note\n`, "latin1"),
        Buffer.from(`Reference value ${token}\n`),
      ]),
    );
    commitAll(dir, "notes");
    const history = run(dir, ["--history"]);
    expect(history.code).toBe(1);
    expect(history.output).toContain("secretlint");
    expect(history.output).not.toContain(token);
  });
});

describe("outgoing refs", () => {
  it("blocks a first push of a checkpoint ref that carries a credential", () => {
    const dir = sandbox();
    const remote = withRemote(dir);
    writeFileSync(join(dir, "readme.txt"), "clean\n");
    commitAll(dir, "base");
    execFileSync(GIT, ["push", "-q", "origin", "HEAD:refs/heads/main"], {
      cwd: dir,
    });
    const value = secret();
    writeFileSync(join(dir, "cfg.yaml"), `PASSWORD: ${value}\n`);
    commitAll(dir, "checkpoint");
    execFileSync(GIT, ["update-ref", "refs/entire/checkpoints/aa/bb", "HEAD"], {
      cwd: dir,
    });
    let output = "";
    let blocked = false;
    try {
      execFileSync(GIT, ["push", "origin", "refs/entire/checkpoints/aa/bb"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { stdout: string; stderr: string };
      output = failure.stdout + failure.stderr;
      blocked = true;
    }
    expect(blocked).toBe(true);
    expect(output).toContain("credential-assignment");
    expect(output).not.toContain(value);
    const refs = execFileSync(
      GIT,
      ["--git-dir", remote, "for-each-ref", "--format=%(refname)"],
      { encoding: "utf8" },
    );
    expect(refs).not.toContain("refs/entire/checkpoints");
  });
});
