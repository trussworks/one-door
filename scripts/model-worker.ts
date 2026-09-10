// This entry point dispatches billable calls; tests inject their own provider.
import { anthropicProvider, resolveApiKey } from "../src/models/provider.ts";
import { runWorkerLoop, verifyWorkerDatabase } from "../src/models/worker.ts";
import { workerHealthFile } from "../src/models/worker-health.ts";

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

// Fail at startup, not on the first job, when credentials are absent. The
// message names the missing configuration and never the credential itself.
try {
  await resolveApiKey();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "model credentials unavailable",
  );
  process.exit(1);
}
await verifyWorkerDatabase();
console.log("model worker ready; database verified");
await runWorkerLoop({
  provider: anthropicProvider(),
  workerId: `worker-${process.pid}`,
  idleDelayMs: 2000,
  signal: controller.signal,
  healthFile: workerHealthFile,
});
console.log("model worker stopped");
