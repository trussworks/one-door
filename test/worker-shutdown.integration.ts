// Acceptance row A17, exercised against the production worker loop running in
// the release image, with real Docker signals rather than simulated ones.
//
// Two outcomes are required. A graceful SIGTERM must let an in-flight provider
// call finish and settle the job inside the shutdown budget. A real SIGKILL
// must leave the leased job recoverable: a later worker reclaims it after the
// lease genuinely expires, the interrupted call is reconciled to failed at its
// reserved cost so the spend evidence survives, retries stay bounded, and the
// business writes happen once.
//
// The lease is the production default of 120 seconds and the test waits for it
// to expire in real time, so recovery is measured elapsed rather than a clock
// fixture. Nothing is deleted; every database and container is reported.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";

import postgres from "postgres";

import { enqueueModelJob } from "../src/models/index.ts";
import { createVisitor, saveDraft } from "../src/workflow/index.ts";

const run = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const image = process.env.ONE_DOOR_IMAGE;
const url = process.env.DATABASE_URL;
const containerUrl = process.env.CONTAINER_DATABASE_URL;

if (!image) throw new Error("Set ONE_DOOR_IMAGE to the release image");
if (!url || !new URL(url).pathname.startsWith("/one_door_shutdown"))
  throw new Error(
    "Set DATABASE_URL to a fresh one_door_shutdown_* database on the isolated cluster",
  );
if (!containerUrl)
  throw new Error(
    "Set CONTAINER_DATABASE_URL to the same database as the container reaches it",
  );
if (Number(new URL(url).port) === 5432)
  throw new Error(
    "Use the dedicated validation server, not the development database",
  );
process.env.DATABASE_URL = url;

const LEASE_SECONDS = 120;
const SHUTDOWN_BUDGET_MS = 120_000;
const prefix = "one-door-shutdown-" + randomUUID().slice(0, 8);
const created: string[] = [];
const fixturesVolume = prefix + "-fixtures";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const content = {
  title: "Deploy the grants tracking application",
  problem: "Grant awards are tracked in spreadsheets that drift apart.",
  affectedPeople: "Grants office staff across three programs",
  acceptanceCriteria: ["A single tracked award list stays current"],
  requirements: ["State identity integration"],
  constraints: ["Data stays in Colorado systems"],
  unknowns: ["Expected launch quarter"],
};

async function docker(...args: string[]) {
  return (
    await run("docker", args, { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 })
  ).stdout.trim();
}

async function runScript(name: string) {
  await run(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL(`scripts/${name}`, repoRoot)),
    ],
    {
      cwd: fileURLToPath(repoRoot),
      env: { ...process.env, DATABASE_URL: url },
    },
  );
}

/** Starts the child worker in the release image, fixtures mounted read-only. */
async function startWorker(name: string, offeringId: string) {
  const container = `${prefix}-${name}`;
  created.push(container);
  await docker(
    "run",
    "--detach",
    "--init",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--name",
    container,
    ...(process.platform === "linux"
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
    "--volume",
    `${fixturesVolume}:/app/test:ro`,
    "--env",
    `DATABASE_URL=${containerUrl}`,
    "--env",
    `WORKER_OFFERING_ID=${offeringId}`,
    "--env",
    `WORKER_CONTENT=${JSON.stringify(content)}`,
    "--env",
    `WORKER_ID=${container}`,
    "--env",
    `WORKER_PROVIDER_HOLD_MS=${process.env.WORKER_PROVIDER_HOLD_MS ?? 8000}`,
    image!,
    "node",
    "--experimental-strip-types",
    "test/worker-shutdown-child.ts",
  );
  return container;
}

async function waitForLog(container: string, event: string, budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const logs = await docker("logs", container).catch(() => "");
    if (logs.includes(`"${event}"`)) return;
    await pause(200);
  }
  throw new Error(`${container}: ${event} not observed within ${budgetMs}ms`);
}

async function jobRow(jobId: string) {
  const [row] = await sql`
    SELECT status, attempt_count, lease_owner, lease_token,
           lease_expires_at, current_model_call_id
      FROM model_jobs WHERE id = ${jobId}`;
  return row;
}

// model_calls carries no job column: model_jobs.current_model_call_id points
// one way. Each draft here holds exactly one job of one purpose, so the draft
// and purpose together select that job's receipts, including superseded ones
// the job no longer points at.
async function callRows(draftId: string) {
  return sql`
    SELECT status, sanitized_error, reserved_cost_micros, actual_cost_micros
      FROM model_calls
      WHERE draft_id = ${draftId} AND purpose = 'intake_interpret'
      ORDER BY created_at`;
}

async function enqueueFor(title: string) {
  const visitor = await createVisitor();
  const draft = await saveDraft(visitor, {
    organizationId: organization.id,
    rawNeed: `We need ${title}.`,
    content: { ...content, title },
    state: "ready",
  });
  const job = await enqueueModelJob(visitor, {
    purpose: "intake_interpret",
    draftId: draft.draftId,
  });
  return { ...job, draftId: draft.draftId };
}

let organization: { id: string };

try {
  // Docker CP avoids Docker Desktop's host-filesharing mount path. Only the
  // fixture is copied; the application code remains the image's own source.
  await docker("volume", "create", fixturesVolume);
  const carrier = prefix + "-fixture-copy";
  created.push(carrier);
  await docker(
    "create",
    "--name",
    carrier,
    "--volume",
    `${fixturesVolume}:/app/test`,
    image,
    "node",
    "--version",
  );
  await docker(
    "cp",
    fileURLToPath(new URL("test/worker-shutdown-child.ts", repoRoot)),
    `${carrier}:/app/test/worker-shutdown-child.ts`,
  );
  await runScript("db-migrate.ts");
  await runScript("db-seed.ts");
  [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [offering] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM service_offerings WHERE lifecycle = 'active' LIMIT 1`,
  );

  // ── Graceful SIGTERM settles an in-flight call inside the budget ─────────
  const graceful = await enqueueFor("graceful shutdown");
  const gracefulWorker = await startWorker("graceful", offering.id);
  await waitForLog(gracefulWorker, "provider_call_started", 60_000);

  const stopStarted = Date.now();
  // docker stop sends SIGTERM and only escalates after the timeout, which is
  // the signal an ECS stopTimeout produces.
  await docker(
    "stop",
    "--time",
    String(SHUTDOWN_BUDGET_MS / 1000),
    gracefulWorker,
  );
  const stopElapsed = Date.now() - stopStarted;

  const gracefulExit = await docker(
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    gracefulWorker,
  );
  const gracefulLogs = await docker("logs", gracefulWorker);
  assert.ok(
    gracefulLogs.includes('"provider_call_returned"'),
    "the in-flight provider call finished rather than being cut off",
  );
  assert.ok(
    gracefulLogs.includes('"worker_child_stopped"'),
    "the loop exited through its own abort path",
  );
  assert.equal(gracefulExit, "0", "graceful shutdown exits cleanly");
  assert.ok(
    stopElapsed < SHUTDOWN_BUDGET_MS,
    `shutdown took ${stopElapsed}ms, which exceeds the ${SHUTDOWN_BUDGET_MS}ms budget`,
  );

  const settled = await jobRow(graceful.jobId);
  assert.ok(
    ["succeeded", "failed", "superseded"].includes(settled.status),
    `the job settled rather than staying in flight (status ${settled.status})`,
  );
  const settledCalls = await callRows(graceful.draftId);
  assert.equal(settledCalls.length, 1, "one call receipt for one dispatch");
  assert.notEqual(
    settledCalls[0].status,
    "reserved",
    "the receipt was reconciled rather than left reserved",
  );
  console.log(
    JSON.stringify({
      check: "graceful",
      stopElapsedMs: stopElapsed,
      exitCode: Number(gracefulExit),
      jobStatus: settled.status,
      callStatus: settledCalls[0].status,
    }),
  );

  // ── SIGKILL leaves the job leased, recoverable and accounted for ─────────
  const killed = await enqueueFor("forced termination");
  const killedWorker = await startWorker("killed", offering.id);
  await waitForLog(killedWorker, "provider_call_started", 60_000);

  const beforeKill = await jobRow(killed.jobId);
  assert.equal(
    beforeKill.status,
    "leased",
    "the job is leased while in flight",
  );
  assert.ok(beforeKill.lease_owner, "the lease records its owner");
  const reservedAtKill = await callRows(killed.draftId);
  assert.equal(reservedAtKill.length, 1);
  assert.equal(
    reservedAtKill[0].status,
    "reserved",
    "spend is reserved before the call completes",
  );
  const reservedCost = Number(reservedAtKill[0].reserved_cost_micros);
  assert.ok(reservedCost > 0, "the reservation records a cost");

  const killedAt = Date.now();
  await docker("kill", "--signal", "KILL", killedWorker);
  const killedExit = await docker(
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    killedWorker,
  );
  assert.equal(killedExit, "137", "the process was killed, not asked to stop");

  const afterKill = await jobRow(killed.jobId);
  assert.equal(
    afterKill.status,
    "leased",
    "an interrupted job stays leased rather than being lost or reset",
  );
  assert.equal(
    afterKill.lease_owner,
    beforeKill.lease_owner,
    "the dead worker still holds the lease until it expires",
  );
  const afterKillCalls = await callRows(killed.draftId);
  assert.equal(
    afterKillCalls[0].status,
    "reserved",
    "the interrupted receipt is not silently discarded",
  );

  // Real elapsed time, not an adjusted clock: the recovery worker cannot claim
  // the job until the production lease actually expires.
  const [expiry] = await sql`
    SELECT lease_expires_at, now() AS now,
           extract(epoch FROM lease_expires_at - now())::int AS seconds_remaining
      FROM model_jobs WHERE id = ${killed.jobId}`;
  assert.ok(
    expiry.seconds_remaining > 0 && expiry.seconds_remaining <= LEASE_SECONDS,
    `the lease expires within the production window (${expiry.seconds_remaining}s left)`,
  );

  const recoveryWorker = await startWorker("recovery", offering.id);
  await waitForLog(recoveryWorker, "worker_child_ready", 60_000);
  // The recovery worker idles until the lease lapses; this wait is the lease.
  await waitForLog(
    recoveryWorker,
    "provider_call_started",
    (LEASE_SECONDS + 90) * 1000,
  );
  const reclaimedAfterMs = Date.now() - killedAt;
  const [reclaimClock] = await sql`SELECT now() AS observed_at`;
  await waitForLog(recoveryWorker, "provider_call_returned", 120_000);
  await docker("stop", "--time", "120", recoveryWorker);

  assert.ok(
    new Date(reclaimClock.observed_at).getTime() >=
      new Date(expiry.lease_expires_at).getTime(),
    "recovery occurred after the original lease expiry on the database clock",
  );

  const recovered = await jobRow(killed.jobId);
  assert.equal(
    recovered.status,
    "succeeded",
    `the reclaimed job reached a terminal state (status ${recovered.status})`,
  );
  assert.equal(
    recovered.attempt_count,
    2,
    "the reclaim counted as one further bounded attempt",
  );

  const recoveredCalls = await callRows(killed.draftId);
  assert.equal(recoveredCalls.length, 2, "both dispatches left a receipt");
  assert.equal(
    recoveredCalls[0].status,
    "failed",
    "the interrupted call is reconciled to failed rather than dropped",
  );
  assert.equal(
    recoveredCalls[0].sanitized_error,
    "lease_expired",
    "the reconciliation records why the first call ended",
  );
  // The reclaim leaves actual_cost_micros unset rather than writing a measured
  // usage it never observed. Spend accounting reads
  // coalesce(actual_cost_micros, reserved_cost_micros) (src/models/jobs.ts),
  // so the reservation is what gets charged. Assert the charge, not the column.
  assert.equal(
    recoveredCalls[0].actual_cost_micros,
    null,
    "no usage is invented for a call whose result never arrived",
  );
  assert.equal(
    Number(recoveredCalls[0].reserved_cost_micros),
    reservedCost,
    "the reservation survives the reclaim unchanged",
  );
  const [charged] = await sql`
    SELECT coalesce(sum(coalesce(actual_cost_micros, reserved_cost_micros)), 0)::bigint
             AS micros
      FROM model_calls
      WHERE draft_id = ${killed.draftId} AND status = 'failed'`;
  assert.equal(
    Number(charged.micros),
    reservedCost,
    "the interrupted call is charged at its reserved cost, never assumed free",
  );

  // One business outcome for two dispatches: the reclaim did not duplicate.
  // The draft was never submitted, so the intake result lands as a draft turn
  // rather than a request revision.
  const [turns] = await sql`
    SELECT count(*)::int AS turns FROM draft_turns
      WHERE draft_id = ${killed.draftId}`;
  const [succeededCalls] = await sql`
    SELECT count(*)::int AS calls FROM model_calls
      WHERE draft_id = ${killed.draftId} AND status = 'succeeded'`;
  assert.equal(
    succeededCalls.calls,
    1,
    "exactly one dispatch was charged as a completed call",
  );
  assert.equal(
    turns.turns,
    1,
    "the recovered job produced exactly one conversation turn",
  );

  console.log(
    JSON.stringify({
      check: "forced-termination",
      killedExitCode: Number(killedExit),
      reclaimedAfterMs,
      leaseSeconds: LEASE_SECONDS,
      attempts: recovered.attempt_count,
      jobStatus: recovered.status,
      receipts: recoveredCalls.map((call) => ({
        status: call.status,
        error: call.sanitized_error,
        reservedMicros: Number(call.reserved_cost_micros),
        actualMicros:
          call.actual_cost_micros === null
            ? null
            : Number(call.actual_cost_micros),
      })),
      succeededCalls: succeededCalls.calls,
      draftTurns: turns.turns,
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
  const kept: Array<{ name: string; status: string }> = [];
  for (const container of created) {
    const exists = await docker(
      "container",
      "ls",
      "-a",
      "--filter",
      `name=^/${container}$`,
      "--format",
      "{{.Names}}",
    );
    if (!exists) continue;
    await docker("stop", "--time", "120", container);
    const state = JSON.parse(
      await docker("inspect", "--format", "{{json .State}}", container),
    );
    assert.equal(state.Running, false, "container stop is confirmed");
    assert.equal(state.Restarting, false, "container is not restarting");
    kept.push({ name: container, status: state.Status });
  }
  console.log(
    JSON.stringify({
      retainedContainers: kept,
      retainedVolume: fixturesVolume,
    }),
  );
}
console.log(
  "Worker shutdown checks passed: graceful settle within budget, forced termination recovered with preserved spend evidence and no duplicated business writes.",
);
