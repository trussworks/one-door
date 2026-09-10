import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { runWorkerLoop } from "../src/models/worker.ts";
import { browserModel } from "./browser-model.ts";

const run = promisify(execFile);
const database = new URL(
  process.env.DATABASE_URL || "postgresql://localhost/missing",
);
if (!database.pathname.startsWith("/one_door_e2e"))
  throw new Error("Browser tests require an isolated one_door_e2e database");
for (const script of ["db-migrate.ts", "db-seed.ts"])
  await run(process.execPath, [
    "--experimental-strip-types",
    "scripts/" + script,
  ]);

const controller = new AbortController();
const app = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "4181",
  ],
  { stdio: "inherit" },
);
const ended = once(app, "exit");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    controller.abort();
    app.kill(signal);
  });
app.once("exit", () => controller.abort());
await runWorkerLoop({
  provider: browserModel,
  workerId: "browser-test-worker",
  idleDelayMs: 100,
  signal: controller.signal,
});
const [code] = await ended;
if (typeof code === "number" && code !== 0) process.exitCode = code;
