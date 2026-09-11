import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const database = process.env.CONTAINER_DATABASE_URL;
if (!database || !new URL(database).pathname.startsWith("/one_door_container"))
  throw new Error(
    "CONTAINER_DATABASE_URL must identify an isolated one_door_container database",
  );
const prefix = "one-door-check-" + randomBytes(5).toString("hex");
const image = process.env.ONE_DOOR_IMAGE || "one-door:local";
const code = randomBytes(16).toString("hex");
const secret = randomBytes(32).toString("hex");
const origin = "http://127.0.0.1:4195";
const created: string[] = [];

async function docker(...args: string[]) {
  return (
    await run("docker", args, { maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
}
async function start(name: string, options: string[], command: string[]) {
  const container = prefix + "-" + name;
  created.push(container);
  return docker(
    "run",
    "--name",
    container,
    ...(process.platform === "linux"
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
    "--env",
    "DATABASE_URL=" + database,
    ...options,
    image,
    ...command,
  );
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(250);
  }
  throw new Error("Container did not become ready within 60 seconds");
}

// The runtime image has no shell and no npm, so every command is direct node
// argv, exactly as the task definitions invoke it.
const nodeCommand = (...argv: string[]) => [
  "node",
  "--experimental-strip-types",
  ...argv,
];

try {
  const migration = await start(
    "migrate",
    [],
    nodeCommand("scripts/db-migrate.ts"),
  );
  assert.match(migration, /Applied \d+ migration\(s\)\./);
  const cmd = await docker(
    "inspect",
    "--format",
    "{{json .Config.Cmd}}",
    image,
  );
  assert.match(cmd, /next\/dist\/bin\/next/, "web starts as direct node argv");
  assert.match(cmd, /70000/, "keep-alive stays above a 60s proxy idle timeout");
  const labels = JSON.parse(
    await docker("inspect", "--format", "{{json .Config.Labels}}", image),
  );
  assert.equal(
    labels["org.opencontainers.image.revision"],
    process.env.SOURCE_REVISION ?? "",
    "the revision label carries the source revision, not the release id",
  );
  assert.equal(labels["io.one-door.release-id"], process.env.RELEASE_ID ?? "");
  assert.equal(
    labels["org.opencontainers.image.source"],
    process.env.SOURCE_URL ?? "",
    "the image source label names the repository that built it",
  );

  // The base makes node its entrypoint; clearing it keeps the task
  // definitions' ["node", "--experimental-strip-types", …] commands working.
  assert.equal(
    await docker("inspect", "--format", "{{json .Config.Entrypoint}}", image),
    "null",
    "no inherited entrypoint prefixes the configured command",
  );
  const facts = JSON.parse(
    await start(
      "runtime-facts",
      [],
      [
        "node",
        "-e",
        "const tls=require('node:tls'),fs=require('node:fs');" +
          "const bundle=fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS,'utf8');" +
          "process.stdout.write(JSON.stringify({" +
          "major: Number(process.versions.node.split('.')[0])," +
          "version: process.versions.node," +
          "bundledRoots: tls.rootCertificates.length," +
          "rdsCertificates: bundle.split('BEGIN CERTIFICATE').length - 1," +
          "extraCaPath: process.env.NODE_EXTRA_CA_CERTS}))",
      ],
    ),
  );
  const pinnedNode = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  ).match(/^ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)-/m)?.[1];
  assert.ok(pinnedNode, "the builder pins a readable Node patch version");
  assert.equal(
    facts.version,
    pinnedNode,
    "the runtime carries the pinned Node build, not the base's bundled one",
  );
  assert.ok(
    facts.bundledRoots > 100,
    "Node keeps its bundled authorities, so provider TLS still verifies",
  );
  assert.ok(
    facts.rdsCertificates > 50,
    "the RDS authority bundle is present and parses",
  );
  assert.equal(facts.extraCaPath, "/app/certs/rds-global-bundle.pem");

  // A volume mounted where the image declares VOLUME keeps the image path's
  // ownership; the same mount without a VOLUME directive is root-owned 0755.
  const writeProbe = [
    "node",
    "-e",
    "const fs=require('node:fs');" +
      "for (const p of ['/app/.next/cache/probe','/tmp/probe']) fs.writeFileSync(p,'x');",
  ];
  await start(
    "readonly-writes",
    ["--read-only", "--volume", "/app/.next/cache", "--volume", "/tmp"],
    writeProbe,
  );
  await assert.rejects(
    start(
      "readonly-unmatched",
      [
        "--read-only",
        "--volume",
        "/app/.next/cache",
        "--volume",
        "/app/unmatched",
      ],
      [
        "node",
        "-e",
        "require('node:fs').writeFileSync('/app/unmatched/probe','x');",
      ],
    ),
    (error: Error & { stderr?: string; stdout?: string }) =>
      /EACCES|permission denied/i.test(
        (error.stderr ?? "") + (error.stdout ?? ""),
      ),
    "a mount without a matching VOLUME directive stays unwritable for node",
  );
  const unmigrated = new URL(database);
  unmigrated.pathname = "/postgres";
  await assert.rejects(
    start(
      "web-unmigrated",
      [
        "--env",
        "DATABASE_URL=" + unmigrated.href,
        "--env",
        "DEMO_ACCESS_CODE=" + code,
        "--env",
        "SESSION_SECRET=" + secret,
        "--env",
        "APP_ORIGIN=" + origin,
      ],
      [],
    ),
    (error: Error & { stderr?: string; stdout?: string }) =>
      /web startup blocked/.test((error.stderr ?? "") + (error.stdout ?? "")),
    "web must refuse to serve against an unmigrated database",
  );
  await start(
    "web",
    [
      "--detach",
      "--publish",
      "127.0.0.1:4195:3000",
      "--env",
      "DEMO_ACCESS_CODE=" + code,
      "--env",
      "SESSION_SECRET=" + secret,
      "--env",
      "APP_ORIGIN=" + origin,
    ],
    [],
  );
  await eventually(async () => {
    try {
      return (await fetch(origin + "/api/health")).ok;
    } catch {
      return false;
    }
  });
  // Asked of node, because the image ships no id binary and no shell.
  assert.equal(
    await docker(
      "exec",
      prefix + "-web",
      "node",
      "-e",
      "process.stdout.write(`${process.getuid()}:${process.getgid()}`)",
    ),
    "1000:1000",
    "the web process keeps the unprivileged identity the volumes are owned by",
  );
  assert.equal((await fetch(origin + "/api/work")).status, 401);
  const response = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ code }),
  });
  assert.equal(
    response.status,
    200,
    "production container accepts the configured demo code",
  );
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  const own = await fetch(origin + "/api/work", {
    headers: { Cookie: cookie },
  });
  assert.equal(own.status, 200);
  assert.deepEqual((await own.json()).requests, []);
  // next start re-reads next.config.ts. When the runtime image omits the
  // config, the server falls back to defaults and serves its own chunks from
  // /_next/static while the built HTML still points at /_assets/<release>.
  // Both answer 200, so nothing fails visibly: the page loads two runtimes,
  // never hydrates, and a dynamic route sticks on its loading state. Reading
  // the Dockerfile cannot catch that; only the served HTML can.
  const releaseId = process.env.RELEASE_ID ?? "";
  const dynamicHtml = await (
    await fetch(origin + "/review/00000000-0000-4000-8000-000000000000", {
      headers: { Cookie: cookie },
    })
  ).text();
  const sources = [
    ...dynamicHtml.matchAll(/(?:src|href)="([^"]*_next\/static[^"]*)"/g),
  ].map((match) => match[1]);
  assert.ok(sources.length > 0, "the dynamic page must reference the bundle");
  if (releaseId) {
    assert.deepEqual(
      sources.filter((source) => !source.startsWith(`/_assets/${releaseId}/`)),
      [],
      "every dynamic-page asset must use the release prefix; a bare /_next/static reference means the runtime lost next.config.ts",
    );
    assert.ok(
      (await fetch(origin + "/").then((r) => r.text())).includes(
        `/_assets/${releaseId}/`,
      ),
      "the static page must use the same release prefix as the dynamic page",
    );
  }

  const live = await fetch(origin + "/api/live");
  assert.equal(live.status, 200, "liveness answers without the database");
  assert.equal((await live.json()).status, "live");
  await assert.rejects(
    start("worker-nokey", [], nodeCommand("scripts/model-worker.ts")),
    (error: Error & { stderr?: string; stdout?: string }) =>
      /model credentials unavailable/.test(
        (error.stderr ?? "") + (error.stdout ?? ""),
      ),
    "worker without credentials must fail at startup with a safe message",
  );
  await start(
    "worker",
    // Presence check only; no job exists, so no billable call can occur.
    [
      "--detach",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--env",
      `ANTHROPIC_API_KEY=${randomBytes(16).toString("hex")}`,
    ],
    nodeCommand("scripts/model-worker.ts"),
  );
  await eventually(async () =>
    (await docker("logs", prefix + "-worker")).includes(
      "model worker ready; database verified",
    ),
  );
  assert.equal(
    await docker(
      "inspect",
      "--format",
      "{{.State.Running}}",
      prefix + "-worker",
    ),
    "true",
  );
  const worker = prefix + "-worker";
  const healthCommand = [
    "exec",
    worker,
    ...nodeCommand("scripts/worker-health.ts"),
  ];
  await eventually(async () => {
    try {
      await docker(...healthCommand);
      return true;
    } catch {
      return false;
    }
  });
  // Freeze the actual loop so it cannot overwrite the deliberately bad marker.
  await docker("kill", "--signal", "STOP", worker);
  try {
    for (const timestamp of ["String(Date.now() - 300001)", "'malformed'"]) {
      await docker(
        "exec",
        worker,
        ...nodeCommand(
          "--input-type=module",
          "-e",
          "import {writeFileSync} from 'node:fs'; import {workerHealthFile} from './src/models/worker-health.ts'; writeFileSync(workerHealthFile," +
            timestamp +
            ");",
        ),
      );
      await assert.rejects(
        docker(...healthCommand),
        { code: 1 },
        "stale or malformed loop progress must fail the real runtime health command",
      );
    }
  } finally {
    await docker("kill", "--signal", "CONT", worker);
  }
  await eventually(async () => {
    try {
      await docker(...healthCommand);
      return true;
    } catch {
      return false;
    }
  });
  console.log(
    "Container checks passed: migrations, startup validation, direct-node command, image labels, read-only root with writable declared volumes, non-root production web, gate, database-backed view, liveness, worker credential gate, worker startup.",
  );
} finally {
  for (const container of created) {
    const exists = await docker(
      "container",
      "ls",
      "-a",
      "--filter",
      "name=^/" + container + "$",
      "--format",
      "{{.Names}}",
    );
    if (!exists) continue;
    await docker("stop", "--time", "120", container);
    assert.equal(
      await docker("inspect", "--format", "{{.State.Running}}", container),
      "false",
    );
  }
  console.log(
    "Stopped containers retained for inspection:",
    created.join(", "),
  );
}
