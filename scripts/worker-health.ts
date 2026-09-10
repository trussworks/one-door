import { workerIsLive } from "../src/models/worker-health.ts";

process.exitCode = workerIsLive() ? 0 : 1;
