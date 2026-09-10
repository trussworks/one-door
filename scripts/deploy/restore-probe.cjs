// The restore rehearsal probe. check-restore.ts reads this file and ships it
// as a container override, so it runs under `node -e` in CommonJS: load every
// module with a dynamic import rather than a top-level import or require.
// The evidence marker below must match EVIDENCE_MARKER in check-restore.ts.

const EVIDENCE_MARKER = "one-door-restore-evidence:";
const ORIGIN = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 15000;
const READY_ATTEMPTS = 60;
const TERM_WAIT_MS = 20000;
const KILL_WAIT_MS = 10000;

// #region stopServer
/**
 * Signalling a process does not stop it: this reports true only after the exit
 * event actually fires, first for SIGTERM and then for SIGKILL.
 */
async function stopServer(child, termMs, killMs) {
  let ended = false;
  const exited = new Promise((resolve) =>
    child.once("exit", () => {
      ended = true;
      resolve();
    }),
  );
  const wait = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer.unref) timer.unref();
    });
  child.kill("SIGTERM");
  await Promise.race([exited, wait(termMs)]);
  if (ended) return true;
  child.kill("SIGKILL");
  await Promise.race([exited, wait(killMs)]);
  return ended;
}
// #endregion stopServer

// #region httpGet
function get(path, headers) {
  return fetch(ORIGIN + path, {
    headers: headers || {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}
// #endregion httpGet

function useRestoredDatabase() {
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = process.env.RESTORE_DATABASE_HOST;
  process.env.DATABASE_URL = url.href;
}

async function readDiagnostic() {
  const { inspectDatabase } = await import("/app/scripts/db-inspect.ts");
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 5,
  });
  try {
    return await inspectDatabase(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function startServer() {
  const { spawn } = await import("node:child_process");
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--keepAliveTimeout",
      "70000",
    ],
    { cwd: "/app", stdio: "inherit" },
  );
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    let live = false;
    try {
      live = (await get("/api/live")).ok;
    } catch {
      live = false;
    }
    if (live) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return server;
}

/**
 * readJson calls requireSameOrigin, so a POST without an Origin header
 * matching APP_ORIGIN is refused with 403 before the body is read.
 */
async function enterSession(flows) {
  const entered = await fetch(ORIGIN + "/api/session", {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      origin: new URL(process.env.APP_ORIGIN).origin,
    },
    body: JSON.stringify({ code: process.env.DEMO_ACCESS_CODE }),
  });
  flows.session = entered.status;
  return (entered.headers.getSetCookie() || [])
    .map((value) => value.split(";")[0])
    .join("; ");
}

// #region queueRead
/**
 * Records the status before reading the body: a malformed 200 must still
 * report the status the queue answered with.
 * queueView returns paginate() output: rows, total, page, pageCount.
 */
async function readQueue(flows, cookie) {
  const queue = await get("/api/queue", { cookie });
  flows.queue = queue.status;
  const body = queue.ok ? await queue.json() : {};
  flows.queueTotal = Number.isInteger(body.total) ? body.total : -1;
  flows.queueRows = Array.isArray(body.rows) ? body.rows.length : -1;
}
// #endregion queueRead

/**
 * serverStopped is recorded only when every flow ran: a rehearsal that did not
 * finish must not read as a clean shutdown.
 */
async function measureFlows(flows) {
  const server = await startServer();
  let stopped = false;
  try {
    flows.live = (await get("/api/live")).status;
    flows.health = (await get("/api/health")).status;
    const cookie = await enterSession(flows);
    await readQueue(flows, cookie);
    flows.sessionReadBack = (await get("/api/session", { cookie })).status;
  } finally {
    stopped = await stopServer(server, TERM_WAIT_MS, KILL_WAIT_MS);
  }
  flows.serverStopped = stopped ? 1 : 0;
}

// #region rehearsalPassed
/**
 * Preserved history is the point of the rehearsal: an empty queue means the
 * restore did not carry the requests the saved evidence describes.
 */
function rehearsalPassed(evidence) {
  const { flows, diagnostic } = evidence;
  return (
    flows.live === 200 &&
    flows.health === 200 &&
    flows.session === 200 &&
    flows.queue === 200 &&
    flows.sessionReadBack === 200 &&
    diagnostic !== null &&
    flows.queueTotal > 0 &&
    flows.serverStopped === 1
  );
}
// #endregion rehearsalPassed

async function main() {
  const evidence = { diagnostic: null, flows: {}, ok: false };
  try {
    useRestoredDatabase();
    evidence.diagnostic = await readDiagnostic();
    await measureFlows(evidence.flows);
    evidence.ok = rehearsalPassed(evidence);
  } catch (error) {
    evidence.error = error instanceof Error ? error.name : "unknown";
  }
  console.log(EVIDENCE_MARKER + JSON.stringify(evidence));
  process.exit(evidence.ok ? 0 : 1);
}

void main();
