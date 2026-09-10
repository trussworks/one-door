// A worker process for the shutdown check, run inside the release image with
// this file bind-mounted read-only at /app/test. It mirrors
// scripts/model-worker.ts exactly in the parts under test — the same signal
// handling, the same production runWorkerLoop, the same default lease — and
// differs only in the provider, which must never be billable here.
import { runWorkerLoop } from "../src/models/worker.ts";
import { workerHealthFile } from "../src/models/worker-health.ts";

const holdMs = Number(process.env.WORKER_PROVIDER_HOLD_MS ?? 3000);
const offeringId = process.env.WORKER_OFFERING_ID ?? "";
const content = JSON.parse(process.env.WORKER_CONTENT ?? "{}");

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

/**
 * Holds for a bounded time so the parent can signal a genuinely in-flight
 * call, then returns output the intake contract accepts. Usage is fixed so
 * the reconciled cost is predictable.
 */
const provider = {
  async complete() {
    console.log(JSON.stringify({ event: "provider_call_started" }));
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    console.log(JSON.stringify({ event: "provider_call_returned" }));
    return {
      outputText: JSON.stringify({
        content,
        questions: ["Which programs adopt the tracker first?"],
        services: [
          {
            offeringId,
            fitBand: "possible",
            coverage: ["Application deployment path"],
            gaps: ["Grants workflow remains custom"],
            relatedOfferingKeys: [],
            rationale: "The offering hosts applications of this shape.",
          },
        ],
      }),
      inputTokens: 1000,
      outputTokens: 500,
    };
  },
};

console.log(JSON.stringify({ event: "worker_child_ready", pid: process.pid }));
await runWorkerLoop({
  healthFile: workerHealthFile,
  provider,
  workerId: process.env.WORKER_ID ?? `shutdown-check-${process.pid}`,
  idleDelayMs: 200,
  metricsIntervalMs: 3_600_000,
  signal: controller.signal,
});
console.log(JSON.stringify({ event: "worker_child_stopped" }));
