import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  errorCode,
  futureObjectsAreUsable,
  judgeRefusal,
  summarize,
} from "../../scripts/rds-acceptance.mjs";

it("imports as a library without opening database connections", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import('./scripts/rds-acceptance.mjs'); console.log('imported');",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNTIME_DATABASE_URL: "invalid",
        MIGRATION_DATABASE_URL: "invalid",
        DIAGNOSTIC_DATABASE_URL: "invalid",
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("imported");
});

it("fails malformed configuration without disclosing its value", () => {
  const value = "malformed-private-database-value";
  const result = spawnSync(process.execPath, ["scripts/rds-acceptance.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNTIME_DATABASE_URL: value,
      MIGRATION_DATABASE_URL: value,
      DIAGNOSTIC_DATABASE_URL: value,
      DB_NAME: "one_door",
      DB_SSLMODE: "verify-full",
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('"complete":false');
  expect(result.stderr).not.toContain(value);
});

it("reports an error's identity and never its message", () => {
  expect(
    errorCode({ code: "42501", message: "…for table actors, value x" }),
  ).toBe("42501");
  expect(errorCode({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe(
    "ERR_TLS_CERT_ALTNAME_INVALID",
  );
  for (const shapeless of [
    new Error(`password=${randomBytes(16).toString("hex")}`),
    { code: 42501 },
    { code: "no such entry for host 10.0.0.1" },
    null,
  ])
    expect(errorCode(shapeless)).toBe("UNIDENTIFIED");
});

it("fails a refusal check when the statement was permitted", () => {
  const permitted = judgeRefusal(["42501"], { succeeded: true, code: "NONE" });
  expect(permitted.status).toBe("fail");
  expect(permitted.detail).toEqual({
    refused: false,
    reason: "the statement was permitted",
  });
});

it("passes a refusal only for an expected reason", () => {
  expect(
    judgeRefusal(["25006", "42501"], { succeeded: false, code: "42501" }),
  ).toEqual({ status: "pass", detail: { refused: true, code: "42501" } });
  const wrongReason = judgeRefusal(["42501"], {
    succeeded: false,
    code: "42P01",
  });
  expect(wrongReason.status).toBe("fail");
  expect(wrongReason.detail.reason).toBe("refused for an unexpected reason");
});

it("treats an environment limit as missing evidence, not as a pass", () => {
  const limited = summarize([
    { check: "a", status: "pass" },
    { check: "b", status: "limit" },
  ]);
  expect(limited).toEqual({
    pass: 1,
    fail: 0,
    limit: 1,
    checks: 2,
    complete: false,
    exitCode: 1,
  });

  const clean = summarize([{ check: "a", status: "pass" }]);
  expect(clean.complete).toBe(true);
  expect(clean.exitCode).toBe(0);

  const broken = summarize([
    { check: "a", status: "pass" },
    { check: "b", status: "fail" },
  ]);
  expect(broken.complete).toBe(false);
  expect(broken.exitCode).toBe(1);
});

it("requires the next migration's objects to be usable and still protected", () => {
  const usable = {
    runtime_insert: true,
    runtime_select: true,
    runtime_update: true,
    runtime_delete: true,
    runtime_sequence: true,
    diagnostic_select: true,
    diagnostic_insert: false,
  };
  expect(futureObjectsAreUsable(usable)).toBe(true);
  for (const field of [
    "runtime_insert",
    "runtime_select",
    "runtime_update",
    "runtime_delete",
    "runtime_sequence",
    "diagnostic_select",
  ])
    expect(futureObjectsAreUsable({ ...usable, [field]: false }), field).toBe(
      false,
    );
  // A diagnostic role that can write a new table is too broad, not "extra".
  expect(futureObjectsAreUsable({ ...usable, diagnostic_insert: true })).toBe(
    false,
  );
});
