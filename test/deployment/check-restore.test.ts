import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { expect, it } from "vitest";

import {
  buildContainerOverride,
  compareDiagnostics,
  MAX_OVERRIDE_BYTES,
  overrideByteLength,
  parseProbeEvidence,
  PROBE_SOURCE,
  requireCaller,
  requireReleasedTask,
  requireRestoreTarget,
  parseDiagnostic,
  requireSafeOverride,
  QUEUE_READ_SOURCE,
  REHEARSAL_PASSED_SOURCE,
  STOP_SERVER_SOURCE,
  type Diagnostic,
  type InstanceFacts,
} from "../../scripts/deploy/check-restore.ts";

const source: InstanceFacts = {
  DBInstanceIdentifier: "one-door-personal",
  DBInstanceStatus: "available",
  PubliclyAccessible: false,
  StorageEncrypted: true,
  KmsKeyId: "arn:aws:kms:us-west-2:845191826742:key/b41478a3",
  Endpoint: { Address: "one-door-personal.abc.us-west-2.rds.amazonaws.com" },
  EngineVersion: "18.6",
  DBSubnetGroup: { DBSubnetGroupName: "one-door-personal" },
  VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-0180aae5785eb5df0" }],
  DBParameterGroups: [{ DBParameterGroupName: "one-door-personal" }],
};

const target: InstanceFacts = {
  ...source,
  DBInstanceIdentifier: "one-door-personal-restore-20260907",
  Endpoint: {
    Address:
      "one-door-personal-restore-20260907.abc.us-west-2.rds.amazonaws.com",
  },
};

const restoreHost = target.Endpoint!.Address!;

it("refuses a caller in another account before anything is submitted", () => {
  expect(() =>
    requireCaller("845191826742", { account_id: "845191826742" }),
  ).not.toThrow();
  expect(() =>
    requireCaller("111122223333", { account_id: "845191826742" }),
  ).toThrow("account mismatch");
});

it("accepts a restore that kept every protection the source has", () => {
  expect(requireRestoreTarget({ source, target })).toBe(restoreHost);
});

it("refuses the live instance as its own restore target", () => {
  expect(() =>
    requireRestoreTarget({
      source,
      target: { ...target, DBInstanceIdentifier: source.DBInstanceIdentifier },
    }),
  ).toThrow("target is the live instance");
});

it("refuses a restore that weakened any protection", () => {
  const cases: Array<[Partial<InstanceFacts>, string]> = [
    [{ PubliclyAccessible: true }, "publicly accessible"],
    [{ StorageEncrypted: false }, "not encrypted"],
    [
      { KmsKeyId: "arn:aws:kms:us-west-2:845191826742:key/other" },
      "different KMS key",
    ],
    [{ EngineVersion: "17.4" }, "differs from source"],
    [
      { DBSubnetGroup: { DBSubnetGroupName: "default" } },
      "different subnet group",
    ],
    [
      { VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-open" }] },
      "different security groups",
    ],
    [
      { DBParameterGroups: [{ DBParameterGroupName: "default.postgres18" }] },
      "different parameter group",
    ],
    [{ DBInstanceStatus: "creating" }, "not available"],
    [{ Endpoint: {} }, "no endpoint address"],
  ];
  for (const [change, message] of cases)
    expect(
      () => requireRestoreTarget({ source, target: { ...target, ...change } }),
      message,
    ).toThrow(message);
});

it("refuses a target with no security or parameter groups at all", () => {
  expect(() =>
    requireRestoreTarget({
      source: { ...source, VpcSecurityGroups: [] },
      target: { ...target, VpcSecurityGroups: [] },
    }),
  ).toThrow("different security groups");
});

const released = {
  taskDefinition: {
    family: "one-door-personal-web",
    revision: 4,
    status: "ACTIVE",
    containerDefinitions: [
      {
        name: "web",
        image:
          "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@sha256:" +
          "a".repeat(64),
      },
    ],
  },
};
const pin = {
  expectedFamily: "one-door-personal-web",
  expectedRevision: 4,
  expectedImage: released.taskDefinition.containerDefinitions[0].image,
  containerName: "web",
};

it("pins the rehearsal to one released revision and one image digest", () => {
  expect(() =>
    requireReleasedTask({ described: released, ...pin }),
  ).not.toThrow();
  expect(() =>
    requireReleasedTask({ described: released, ...pin, expectedRevision: 5 }),
  ).toThrow("revision 4 is not 5");
  expect(() =>
    requireReleasedTask({
      described: released,
      ...pin,
      expectedFamily: "one-door-personal-worker",
    }),
  ).toThrow("is not one-door-personal-worker");
  expect(() =>
    requireReleasedTask({
      described: {
        taskDefinition: { ...released.taskDefinition, status: "INACTIVE" },
      },
      ...pin,
    }),
  ).toThrow("not ACTIVE");
});

it("refuses an image referenced by tag rather than digest", () => {
  const tagged = {
    taskDefinition: {
      ...released.taskDefinition,
      containerDefinitions: [
        {
          name: "web",
          image:
            "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal:latest",
        },
      ],
    },
  };
  expect(() =>
    requireReleasedTask({
      described: tagged,
      ...pin,
      expectedImage: tagged.taskDefinition.containerDefinitions[0].image,
    }),
  ).toThrow("pinned by digest");
});

it("keeps the override inside the ECS limit", () => {
  const override = buildContainerOverride({
    containerName: "web",
    restoreHost,
  });
  const size = overrideByteLength(override);
  expect(size).toBeLessThan(MAX_OVERRIDE_BYTES);
  expect(requireSafeOverride(override, [])).toBe(size);
});

it("keeps every credential out of the override, which ECS stores in clear text", () => {
  const override = buildContainerOverride({
    containerName: "web",
    restoreHost,
  });
  const text = JSON.stringify(override);
  // The probe rewrites the host inside the container, so the injected URL and
  // its password are never part of the request.
  expect(text).not.toContain("DATABASE_URL=");
  expect(text).not.toContain("postgresql://");
  expect(text).not.toContain("SESSION_SECRET");
  expect(override.containerOverrides[0].environment.map((e) => e.name)).toEqual(
    ["RESTORE_DATABASE_HOST"],
  );
  const password = randomBytes(24).toString("hex");
  expect(() => requireSafeOverride(override, [password])).not.toThrow();
  const leaking = {
    containerOverrides: [
      {
        name: "web",
        environment: [
          { name: "DATABASE_URL", value: `postgresql://u:${password}@h/db` },
        ],
      },
    ],
  };
  expect(() => requireSafeOverride(leaking, [password])).toThrow(
    "contains a credential value",
  );
});

it("rejects an oversized override rather than letting ECS refuse it", () => {
  const bloated = {
    containerOverrides: [
      { name: "web", command: ["node", "-e", "x".repeat(9000)] },
    ],
  };
  expect(() => requireSafeOverride(bloated, [])).toThrow(
    "over the 8192 byte limit",
  );
});

it("refuses a restore host that is not an RDS endpoint", () => {
  for (const host of [
    "evil.example.com",
    "127.0.0.1",
    "one-door.rds.amazonaws.com.evil.net",
  ])
    expect(
      () => buildContainerOverride({ containerName: "web", restoreHost: host }),
      host,
    ).toThrow("must be an RDS endpoint");
});

it("probes real routes and never prints the gate code", () => {
  for (const route of [
    "/api/live",
    "/api/health",
    "/api/session",
    "/api/queue",
  ])
    expect(PROBE_SOURCE).toContain(route);
  // The code is read from the container environment and sent as a request
  // body; it must never reach the evidence line.
  expect(PROBE_SOURCE).toContain("process.env.DEMO_ACCESS_CODE");
  expect(PROBE_SOURCE).not.toMatch(/out\([^)]*DEMO_ACCESS_CODE/);
  expect(PROBE_SOURCE).toContain("127.0.0.1");
  expect(PROBE_SOURCE).not.toContain("0.0.0.0");
  // Inspection runs before any write, so the comparison sees the restore as
  // it arrived rather than as the probe left it.
  expect(PROBE_SOURCE.indexOf("inspectDatabase")).toBeLessThan(
    PROBE_SOURCE.indexOf("/api/session"),
  );
});

const evidenceLine = (payload: unknown) =>
  "one-door-restore-evidence:" + JSON.stringify(payload);

it("reads exactly one evidence line and refuses an uncertain result", () => {
  const payload = { diagnostic: null, flows: { live: 200 }, ok: false };
  expect(parseProbeEvidence(["noise", evidenceLine(payload)])).toEqual(payload);
  expect(() => parseProbeEvidence(["only noise"])).toThrow("found 0");
  expect(() =>
    parseProbeEvidence([evidenceLine(payload), evidenceLine(payload)]),
  ).toThrow("found 2");
});

const saved: Diagnostic = {
  database: { name: "one_door", encoding: "UTF8", collation: "C" },
  migrations: { "0001_initial.sql": "a".repeat(64) },
  fixtures: { baseline: "b".repeat(64) },
  tables: { requests: { rows: 12, sha256: "c".repeat(64) } },
};

it("confirms a restore whose data matches the saved evidence exactly", () => {
  expect(compareDiagnostics(saved, structuredClone(saved))).toEqual({
    ok: true,
    differences: [],
  });
});

it("names every way the restored data departs from the saved evidence", () => {
  const cases: Array<[Diagnostic, string]> = [
    [
      { ...saved, database: { ...saved.database, collation: "en_US.UTF-8" } },
      "collation differs",
    ],
    [
      { ...saved, database: { ...saved.database, encoding: "LATIN1" } },
      "encoding differs",
    ],
    [
      { ...saved, migrations: { "0001_initial.sql": "d".repeat(64) } },
      "migration 0001_initial.sql differs",
    ],
    [{ ...saved, fixtures: {} }, "fixture baseline differs"],
    [
      { ...saved, tables: { requests: { rows: 11, sha256: "c".repeat(64) } } },
      "table requests has 11 rows, saved evidence has 12",
    ],
    [
      { ...saved, tables: { requests: { rows: 12, sha256: "e".repeat(64) } } },
      "table requests content digest differs",
    ],
    [{ ...saved, tables: {} }, "table requests is missing from the restore"],
    [
      {
        ...saved,
        tables: { ...saved.tables, extra: { rows: 1, sha256: "f".repeat(64) } },
      },
      "table extra exists only in the restore",
    ],
  ];
  for (const [observed, message] of cases) {
    const result = compareDiagnostics(saved, observed);
    expect(result.ok, message).toBe(false);
    expect(result.differences.join("; ")).toContain(message);
  }
});

it("runs the probe with type stripping, because it imports a TypeScript module", () => {
  const command = buildContainerOverride({
    containerName: "web",
    restoreHost,
  }).containerOverrides[0].command;
  expect(command.slice(0, 3)).toEqual([
    "node",
    "--experimental-strip-types",
    "-e",
  ]);
  expect(PROBE_SOURCE).toContain("/app/scripts/db-inspect.ts");
});

// ── Defects found by tracing the probe against the deployed image ────────────

it("refuses a comparison when either side reports no KMS key or subnet group", () => {
  // Undefined equals undefined, so a plain equality check passed two
  // instances that both failed to report encryption.
  const blind = { ...source, KmsKeyId: undefined };
  expect(() =>
    requireRestoreTarget({
      source: blind,
      target: { ...target, KmsKeyId: undefined },
    }),
  ).toThrow("no KMS key");
  expect(() =>
    requireRestoreTarget({
      source: { ...source, DBSubnetGroup: undefined },
      target: { ...target, DBSubnetGroup: undefined },
    }),
  ).toThrow("no subnet group");
});

it("sends the Origin header the application requires on a POST", () => {
  // readJson calls requireSameOrigin, which rejects a missing or mismatched
  // Origin with 403 before the body is parsed.
  expect(PROBE_SOURCE).toContain(
    "origin: new URL(process.env.APP_ORIGIN).origin",
  );
  expect(PROBE_SOURCE).toContain('"content-type": "application/json"');
});

it("reads the queue shape the application actually returns", () => {
  // queueView spreads paginate(), which yields rows/total/page/pageCount.
  expect(PROBE_SOURCE).toContain("body.total");
  expect(PROBE_SOURCE).toContain("body.rows");
  expect(PROBE_SOURCE).not.toContain("body.items");
});

// Drives the probe's own acceptance rule rather than matching its text.
const loadRehearsalPassed = async () =>
  (
    (await import(
      "data:text/javascript," +
        encodeURIComponent(
          REHEARSAL_PASSED_SOURCE + "\nexport { rehearsalPassed };",
        )
    )) as {
      rehearsalPassed: (evidence: {
        diagnostic: unknown;
        flows: Record<string, number>;
      }) => boolean;
    }
  ).rehearsalPassed;

const passingEvidence = (): {
  diagnostic: unknown;
  flows: Record<string, number>;
} => ({
  diagnostic: { tables: {} },
  flows: {
    live: 200,
    health: 200,
    session: 200,
    queue: 200,
    sessionReadBack: 200,
    queueTotal: 4,
    queueRows: 4,
    serverStopped: 1,
  },
});

it("accepts a rehearsal only when every flow, the diagnostic and the shutdown hold", async () => {
  const rehearsalPassed = await loadRehearsalPassed();
  expect(rehearsalPassed(passingEvidence())).toBe(true);
});

it("treats an empty queue as a failed rehearsal rather than a pass", async () => {
  const rehearsalPassed = await loadRehearsalPassed();
  const evidence = passingEvidence();
  evidence.flows.queueTotal = 0;
  expect(rehearsalPassed(evidence)).toBe(false);
});

it("refuses a rehearsal whose server never confirmed its exit", async () => {
  const rehearsalPassed = await loadRehearsalPassed();
  const evidence = passingEvidence();
  evidence.flows.serverStopped = 0;
  expect(rehearsalPassed(evidence)).toBe(false);
});

it("refuses a rehearsal that produced no diagnostic", async () => {
  const rehearsalPassed = await loadRehearsalPassed();
  const evidence = passingEvidence();
  evidence.diagnostic = null;
  expect(rehearsalPassed(evidence)).toBe(false);
});

it.each(["live", "health", "session", "queue", "sessionReadBack"])(
  "refuses a rehearsal whose %s flow did not answer 200",
  async (flow) => {
    const rehearsalPassed = await loadRehearsalPassed();
    const evidence = passingEvidence();
    evidence.flows[flow] = 500;
    expect(rehearsalPassed(evidence)).toBe(false);
  },
);

it("bounds every request and waits for the server to exit", () => {
  const fetches = PROBE_SOURCE.match(/fetch\(/g) ?? [];
  const timeouts = PROBE_SOURCE.match(/AbortSignal\.timeout\(/g) ?? [];
  expect(timeouts).toHaveLength(fetches.length);
  expect(PROBE_SOURCE).toContain(STOP_SERVER_SOURCE);
  expect(PROBE_SOURCE).toContain("stopped = await stopServer(server");
});

it("starts the server the released image actually ships", () => {
  // The Dockerfile CMD runs the Next CLI and next.config.ts sets no
  // standalone output, so there is no server.js to run instead.
  expect(PROBE_SOURCE).toContain("node_modules/next/dist/bin/next");
  expect(PROBE_SOURCE).not.toContain("server.js");
});

// ── The shipped shutdown source, driven against real and stalled children ────

// Imported as a module rather than evaluated, so these drive the exact source
// the probe ships instead of a copy of it.
const loadStopServer = async () =>
  (
    (await import(
      "data:text/javascript," +
        encodeURIComponent(STOP_SERVER_SOURCE + "\nexport { stopServer };")
    )) as {
      stopServer: (
        child: unknown,
        termMs: number,
        killMs: number,
      ) => Promise<boolean>;
    }
  ).stopServer;

it("confirms a stop after SIGTERM when the child exits on its own", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
  await once(child, "spawn");
  expect(await (await loadStopServer())(child, 5000, 5000)).toBe(true);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it("escalates and still confirms the exit when the child ignores SIGTERM", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');",
  ]);
  // The spawn event fires before the script runs, so a signal sent then would
  // arrive before the handler exists and would stop the child by default.
  await once(child.stdout, "data");
  // A short SIGTERM budget forces the escalation path.
  expect(await (await loadStopServer())(child, 250, 5000)).toBe(true);
  expect(child.signalCode).toBe("SIGKILL");
});

it("reports failure rather than success when no exit ever arrives", async () => {
  // Signalling is not stopping: a child that never emits exit must not be
  // reported as stopped, however many signals were sent.
  const sent: string[] = [];
  const deaf = Object.assign(new EventEmitter(), {
    kill: (signal: string) => sent.push(signal),
  });
  expect(await (await loadStopServer())(deaf, 20, 20)).toBe(false);
  expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
});

// ── Saved evidence, validated against real inspectDatabase output ────────────

// Shape taken from an actual probe run against the runtime image, not from the
// type declaration.
const observed = {
  database: { name: "one_door", encoding: "UTF8", collation: "C" },
  migrations: { "0001_initial.sql": "8".repeat(64) },
  fixtures: { reference: "6".repeat(64) },
  tables: {
    requests: { rows: 30, sha256: "d".repeat(64) },
    asset_fit_decisions: { rows: 0, sha256: "e".repeat(64) },
  },
};

it("accepts a diagnostic in the shape inspectDatabase actually returns", () => {
  expect(parseDiagnostic(JSON.stringify(observed), "saved.json")).toEqual(
    observed,
  );
});

it("refuses saved evidence that is missing, malformed or not a diagnostic", () => {
  expect(() => parseDiagnostic("{", "saved.json")).toThrow("not valid JSON");
  for (const broken of [
    {},
    { ...observed, database: { name: "one_door" } },
    { ...observed, tables: {} },
    {
      ...observed,
      tables: { requests: { rows: 1.5, sha256: "d".repeat(64) } },
    },
    { ...observed, tables: { requests: { rows: 1, sha256: "short" } } },
    { ...observed, migrations: { "0001_initial.sql": "not-a-digest" } },
    { ...observed, fixtures: [] },
  ])
    expect(
      () => parseDiagnostic(JSON.stringify(broken), "saved.json"),
      JSON.stringify(broken).slice(0, 60),
    ).toThrow("not a database diagnostic");
});

it("runs as shipped under node -e and reports a failure rather than nothing", () => {
  // The probe is evaluated the way the override runs it, with no /app tree and
  // no database, so every collaborator is absent. A rehearsal that cannot run
  // must still print its evidence and exit non-zero.
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "-e", PROBE_SOURCE],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://user@127.0.0.1:1/one_door",
        RESTORE_DATABASE_HOST: "restored.invalid",
        APP_ORIGIN: "https://d111111abcdef8.cloudfront.net",
      },
    },
  );
  expect(result.status).toBe(1);
  const printed = result.stdout
    .split("\n")
    .find((line) => line.includes("one-door-restore-evidence:"));
  expect(printed, "the probe must always print its evidence").toBeTypeOf(
    "string",
  );
  const evidence = JSON.parse(
    (printed as string).slice(
      (printed as string).indexOf("one-door-restore-evidence:") +
        "one-door-restore-evidence:".length,
    ),
  );
  expect(evidence.ok).toBe(false);
  expect(evidence.diagnostic).toBeNull();
  expect(typeof evidence.error).toBe("string");
});

// Drives the probe's own queue read against a controlled server. The run
// happens in a child process so the probe's fetch reaches a real socket rather
// than the test runner's interception.
function readQueueAgainst(status: number, body: string) {
  const program = `
import { createServer } from "node:http";
const server = createServer((_request, response) => {
  response.writeHead(${status}, { "content-type": "application/json" });
  response.end(${JSON.stringify(body)});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const source =
  'const ORIGIN = "http://127.0.0.1:' + port + '";\\n' +
  "const REQUEST_TIMEOUT_MS = 2000;\\n" +
  ${JSON.stringify(QUEUE_READ_SOURCE)} +
  "\\nexport { readQueue };";
const { readQueue } = await import("data:text/javascript," + encodeURIComponent(source));
const flows = { live: 200, health: 200 };
let threw = null;
try {
  await readQueue(flows, "");
} catch (error) {
  threw = error.constructor.name;
}
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(JSON.stringify({ flows, threw }));
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    flows: Record<string, number>;
    threw: string | null;
  };
}

it("keeps the queue status when a 200 body cannot be parsed", () => {
  const { flows, threw } = readQueueAgainst(200, "{not json");
  expect(threw).toBe("SyntaxError");
  // The status is recorded before the body is read, so a malformed answer
  // still reports what the queue replied and never looks like a pass.
  expect(flows.queue).toBe(200);
  expect(flows.live).toBe(200);
  expect(flows.health).toBe(200);
  expect(flows.queueTotal).toBeUndefined();
});

it("records a refused queue without reading its body", () => {
  const { flows, threw } = readQueueAgainst(403, "{not json");
  expect(threw).toBeNull();
  expect(flows.queue).toBe(403);
  expect(flows.queueTotal).toBe(-1);
  expect(flows.queueRows).toBe(-1);
});
