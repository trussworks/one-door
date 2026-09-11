import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: mocks.spawn,
}));

import { runSecretlint } from "../scripts/scan-secrets.ts";

beforeEach(() => {
  mocks.spawn.mockReset();
});

it("reports clean only after a zero exit without an execution error", () => {
  mocks.spawn.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  expect(runSecretlint("/validation")).toEqual([]);
  expect(mocks.spawn).toHaveBeenCalledWith(
    process.execPath,
    [
      expect.stringContaining("secretlint.js"),
      "--maskSecrets",
      "--format",
      "json",
      "**/*",
    ],
    {
      cwd: "/validation",
      encoding: "utf8",
      maxBuffer: 1e9,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  mocks.spawn.mockReturnValue({
    status: 0,
    stdout: "",
    stderr: "",
    error: new Error("output could not be read"),
  });
  expect(runSecretlint("/validation")).toEqual([
    { path: "(secretlint)", line: 0, rule: "secretlint" },
  ]);
});

it("keeps unavailable-engine outcomes separate from findings", () => {
  const unavailable = [
    { path: "(secretlint)", line: 0, rule: "secretlint-unavailable" },
  ];
  mocks.spawn.mockImplementationOnce(() => {
    throw new Error("execution unavailable");
  });
  expect(runSecretlint("/validation")).toEqual(unavailable);
  mocks.spawn.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "Cannot find module",
  });
  expect(runSecretlint("/validation")).toEqual(unavailable);
  // Scanned file bytes inside the stdout JSON must not read as a load failure.
  mocks.spawn.mockReturnValue({
    status: 1,
    stdout: JSON.stringify([
      {
        filePath: "/validation/0-log.txt",
        sourceContent: "Cannot find module",
        messages: [{ messageId: "Basic", loc: { start: { line: 2 } } }],
      },
    ]),
    stderr: "",
  });
  expect(runSecretlint("/validation")).toEqual([
    { path: "0-log.txt", line: 2, rule: "secretlint:Basic" },
  ]);
});

it("keeps validated locations and rules without the embedded file bytes", () => {
  mocks.spawn.mockReturnValue({
    status: 1,
    stdout: JSON.stringify([
      {
        filePath: "/validation/0-config.yaml",
        sourceContent: "raw file bytes stay out of the report",
        messages: [
          {
            ruleId: "@secretlint/secretlint-rule-database-connection-string",
            messageId: "PostgreSQLConnection",
            severity: "error",
            loc: { start: { line: 8, column: 4 } },
          },
          {
            ruleId: "@secretlint/secretlint-rule-npm",
            loc: { start: { line: 17 } },
          },
        ],
      },
      { filePath: "/validation/scan-sentinel.txt", messages: [] },
    ]),
    stderr: "",
  });
  expect(runSecretlint("/validation")).toEqual([
    {
      path: "0-config.yaml",
      line: 8,
      rule: "secretlint:PostgreSQLConnection",
    },
    {
      path: "0-config.yaml",
      line: 17,
      rule: "secretlint:@secretlint/secretlint-rule-npm",
    },
  ]);
});

it.each(["/outside/other.txt", "/validation-sibling/private.txt"])(
  "never echoes an outside path %s",
  (filePath) => {
    mocks.spawn.mockReturnValue({
      status: 1,
      stdout: JSON.stringify([
        {
          filePath,
          messages: [{ messageId: "Basic", loc: { start: { line: 4 } } }],
        },
      ]),
      stderr: "",
    });
    expect(runSecretlint("/validation")).toEqual([
      { path: "(secretlint)", line: 4, rule: "secretlint:Basic" },
    ]);
  },
);

it("fails closed when a nonzero exit carries no parseable finding", () => {
  for (const stdout of [
    "unstructured text",
    JSON.stringify({ not: "an array" }),
    JSON.stringify([{ filePath: "/validation/a", messages: [{}] }]),
    JSON.stringify([{ filePath: "/validation/a", messages: [] }]),
  ]) {
    mocks.spawn.mockReturnValue({ status: 2, stdout, stderr: "" });
    expect(runSecretlint("/validation")).toEqual([
      { path: "(secretlint)", line: 0, rule: "secretlint" },
    ]);
  }
});

it("fails closed for nonzero, signal-terminated and failed-spawn outcomes", () => {
  for (const result of [
    { status: 2, stdout: "unparseable output", stderr: "" },
    { status: null, signal: "SIGTERM", stdout: null, stderr: null },
    {
      status: null,
      error: new Error("spawn failed"),
      stdout: null,
      stderr: null,
    },
  ]) {
    mocks.spawn.mockReturnValue(result);
    expect(runSecretlint("/validation")).toEqual([
      { path: "(secretlint)", line: 0, rule: "secretlint" },
    ]);
  }
});
