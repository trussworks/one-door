import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { unitEnvironment } from "./environment.ts";

it("removes inherited service credentials while retaining tool and runner configuration", () => {
  const control = randomBytes(24).toString("hex");
  const result = unitEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    CI: "true",
    VITEST_POOL_ID: "1",
    npm_execpath: "/tools/npm",
    ONE_DOOR_AWS: "/tools/aws",
    TINYPOOL_WORKER_ID: "1",
    HIGHERGOV_API_KEY: control,
    DATABASE_URL: control,
    DEMO_ACCESS_CODE: control,
    SESSION_SECRET: control,
    AWS_SESSION_TOKEN: control,
    UNRELATED_SERVICE_KEY: control,
  });
  expect(Object.keys(result).sort()).toEqual([
    "CI",
    "HOME",
    "ONE_DOOR_AWS",
    "PATH",
    "TINYPOOL_WORKER_ID",
    "VITEST_POOL_ID",
    "npm_execpath",
  ]);
  expect(Object.values(result).some((value) => value === control)).toBe(false);
});

it("runs unit tests without inherited API credentials or a developer database", () => {
  expect(Object.hasOwn(process.env, "HIGHERGOV_API_KEY")).toBe(false);
  expect(Object.hasOwn(process.env, "AWS_SESSION_TOKEN")).toBe(false);
  const database = new URL(process.env.DATABASE_URL!);
  expect(database.hostname).toBe("127.0.0.1");
  expect(database.port).toBe("1");
  expect(database.pathname).toBe("/one_door_unit");
});
