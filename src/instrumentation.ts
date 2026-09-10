// Next.js calls register() once per server start and waits for it before the
// server is ready to handle requests (installed docs: file-conventions/instrumentation).
export async function register() {
  // Skip the build phase (a build must not need runtime credentials) and
  // development, which keeps its lazy local failure behavior.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV !== "production") return;
  const { validateWebStartup } = await import("./server/startup.ts");
  try {
    await validateWebStartup();
  } catch (error) {
    // Observed on Next 16.3.4: a register() rejection is logged as an
    // unhandledRejection and the server keeps listening. The gate must
    // crash the task so the orchestrator's circuit breaker can act.
    console.error(
      error instanceof Error ? error.message : "web startup blocked",
    );
    process.exit(1);
  }
}
