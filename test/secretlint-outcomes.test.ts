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
    [expect.stringContaining("secretlint.js"), "--maskSecrets", "**/*"],
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
  for (const stream of ["stdout", "stderr"]) {
    mocks.spawn.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
      [stream]: "Cannot find module",
    });
    expect(runSecretlint("/validation")).toEqual(unavailable);
  }
});

it("retains parsed line numbers without returning the engine's raw text", () => {
  mocks.spawn.mockReturnValue({
    status: 1,
    stdout: "  8:4 error masked finding\n  17:2 error another finding\n",
    stderr: "",
  });
  expect(runSecretlint("/validation")).toEqual([
    { path: "(secretlint)", line: 8, rule: "secretlint" },
    { path: "(secretlint)", line: 17, rule: "secretlint" },
  ]);
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
