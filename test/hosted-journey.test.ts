import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

import {
  browserResult,
  callReceipts,
  charged,
  checkQuota,
  finalize,
  journeyCallCeiling,
  journeyFailure,
  requireCount,
  requireHeadroom,
  verifyCharged,
  type JourneyFacts,
} from "./hosted-journey.ts";

const bucket = (used: number, cap: number) => ({
  used,
  cap,
  warn: used >= cap * 0.8,
  exceeded: used >= cap,
});

const quota = (visitor: number, global: number, micros: number) =>
  checkQuota({
    visitorDaily: bucket(visitor, 20),
    globalDaily: bucket(global, 100),
    monthlySpend: bucket(micros, 50_000_000),
  });

const call = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "call-1",
  jobId: "job-1",
  purpose: "intake_interpret",
  status: "succeeded",
  attemptCount: 1,
  reservedCostMicros: 1000,
  actualCostMicros: 900,
  createdAt: "2026-09-08T00:00:00.000Z",
  completedAt: "2026-09-08T00:00:10.000Z",
  validatedOutput: { summary: "model prose that must not be retained" },
  inputHash: "hash",
  idempotencyKey: "key",
  ...over,
});

const completedCalls = () =>
  callReceipts([call(), call({ id: "call-2", purpose: "risk_assess" })]);

const facts = (over: Partial<JourneyFacts> = {}): JourneyFacts => ({
  origin: "https://example.cloudfront.net",
  runId: "run-1",
  startedAt: "2026-09-08T00:00:00.000Z",
  finishedAt: "2026-09-08T00:05:00.000Z",
  draftId: "draft-1",
  requestId: "request-1",
  displayId: "REQ-1",
  jobs: {
    intake_interpret: { jobId: "job-1", status: "succeeded" },
    asset_match: { jobId: "job-2", status: "succeeded" },
    risk_assess: { jobId: "job-3", status: "succeeded" },
  },
  assetResult: { id: "asset-1", modelCallId: "call-1", status: "succeeded" },
  persistedAfterReload: true,
  failure: null,
  ...over,
});

const webDigest = "sha256:" + "d".repeat(64);
const released =
  "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@" + webDigest;

const service = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  serviceName: "one-door-personal-web",
  tasks: 2,
  digests: [webDigest],
  taskArns: ["task-a", "task-b"],
  taskDefinition: "arn:aws:ecs:us-west-2:845191826742:task-definition/web:9",
  healthVerified: true,
  ...over,
});

const worker = (over: Record<string, unknown> = {}) =>
  service({
    serviceName: "one-door-personal-worker",
    taskArns: ["task-c", "task-d"],
    taskDefinition:
      "arn:aws:ecs:us-west-2:845191826742:task-definition/worker:9",
    workerProgressVerified: true,
    workerProgress: ["task-c", "task-d"].map((taskArn) => ({
      taskArn,
      lastSuccessfulPollAt: Date.parse("2026-09-07T23:58:00.000Z"),
      logTimestamp: Date.parse("2026-09-07T23:58:10.000Z"),
    })),
    ...over,
  });

const snapshot = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  verifiedAt: "2026-09-07T23:59:00.000Z",
  origin: "https://example.cloudfront.net",
  accountId: "845191826742",
  released,
  acceptableDigests: [webDigest],
  services: [service(), worker()],
  ...over,
});

it("counts every purpose a submission starts, at the automatic attempt limit", () => {
  // Budget for a separate asset refresh even though intake reuse can avoid it.
  expect(journeyCallCeiling).toBe(6);
});

it("rejects costs and quota figures that survive ordinary comparisons", () => {
  for (const bad of [Number.NaN, Infinity, -1, 1.5, "200000", null, undefined])
    expect(() => requireCount(bad, "The cost allowance")).toThrow(
      "must be a whole number",
    );
  expect(() => checkQuota(null)).toThrow("returned no object");
  expect(() => checkQuota({ visitorDaily: bucket(0, 20) })).toThrow(
    "global daily bucket is missing",
  );
  expect(() =>
    checkQuota({
      visitorDaily: { used: Number.NaN, cap: 20 },
      globalDaily: bucket(0, 100),
      monthlySpend: bucket(0, 1),
    }),
  ).toThrow("visitor daily used must be a whole number");
});

it("starts only when every shared cap has room for the whole worst case", () => {
  expect(() => requireHeadroom(quota(0, 0, 0), 200_000)).not.toThrow();
  expect(() => requireHeadroom(quota(20, 0, 0), 200_000)).toThrow(
    "visitor daily calls cap is already reached",
  );
  expect(() => requireHeadroom(quota(0, 96, 0), 200_000)).toThrow(
    "global daily calls headroom is 4",
  );
  expect(() => requireHeadroom(quota(0, 0, 49_900_000), 200_000)).toThrow(
    "monthly spend headroom is 100000",
  );
  expect(() => requireHeadroom(quota(0, 0, 0), 0)).toThrow(
    "positive cost allowance",
  );
  expect(() => requireHeadroom(quota(0, 0, 0), Number.NaN)).toThrow(
    "must be a whole number",
  );
});

it("keeps this draft's own call ledger and drops model input and output", () => {
  const receipts = callReceipts([
    call(),
    call({ id: "call-2", actualCostMicros: null }),
  ]);
  expect(JSON.stringify(receipts)).not.toContain("model prose");
  expect(JSON.stringify(receipts)).not.toContain("idempotencyKey");
  expect(receipts[1].actualCostMicros).toBeNull();
  // An unsettled call counts at what it reserved, never at zero.
  expect(charged(receipts)).toEqual({ calls: 2, micros: 1900 });
  expect(() => callReceipts("not an array")).toThrow("no call evidence");
  expect(() => callReceipts([call({ reservedCostMicros: -5 })])).toThrow(
    "reserved call cost",
  );
});

it("reports an overrun in calls or cost instead of absorbing it", () => {
  expect(verifyCharged({ calls: 6, micros: 200_000 }, 200_000)).toEqual([]);
  expect(verifyCharged({ calls: 7, micros: 1 }, 200_000)[0]).toContain(
    "made 7 calls",
  );
  expect(verifyCharged({ calls: 1, micros: 300_000 }, 200_000)[0]).toContain(
    "charged 300000 micros",
  );
});

it("never reports a browser-only result as complete", () => {
  const result = browserResult({
    facts: facts(),
    receipts: completedCalls(),
    costAllowance: 200_000,
  });
  expect(result.status).toBe("incomplete");
  expect(result.unverified).toEqual([
    "Pending operator finalization against the deployed release",
  ]);
  expect(result.release).toBeNull();
});

it("names every missing piece of evidence, including before a request exists", () => {
  const early = browserResult({
    facts: facts({
      failure: "page.goto timed out",
      draftId: null,
      requestId: null,
      displayId: null,
      jobs: {},
      persistedAfterReload: false,
    }),
    receipts: [],
    costAllowance: 200_000,
  });
  expect(early.unverified).toContain("page.goto timed out");
  expect(early.unverified).toContain("No draft was created");
  expect(early.unverified).toContain("No request was submitted");
  expect(early.unverified).toContain("No intake_interpret job was observed");
  expect(early.unverified).toContain(
    "The draft recorded no model call, so nothing reached a provider",
  );
  const late = browserResult({
    facts: facts({
      failure: "risk assessment never settled",
      jobs: {
        intake_interpret: { jobId: "job-1", status: "succeeded" },
        risk_assess: { jobId: "job-3", status: "capped" },
      },
      persistedAfterReload: false,
    }),
    receipts: completedCalls(),
    costAllowance: 200_000,
  });
  expect(late.requestId).toBe("request-1");
  expect(late.unverified).toContain("The risk_assess job settled as capped");
  expect(late.unverified).toContain(
    "The results were not observed again after a reload",
  );
});

it("completes only when two operator observations bracket an unchanged release", () => {
  const result = browserResult({
    facts: facts(),
    receipts: completedCalls(),
    costAllowance: 200_000,
  });
  const after = snapshot({ verifiedAt: "2026-09-08T00:06:00.000Z" });
  const changed = (over: Record<string, unknown>) =>
    finalize({
      environment: "personal",
      origin: "https://example.cloudfront.net",
      result,
      before: snapshot(),
      after: { ...after, ...over },
    }).unverified;
  expect(
    finalize({
      environment: "personal",
      origin: "https://example.cloudfront.net",
      result,
      before: snapshot(),
      after,
    }).status,
  ).toBe("complete");
  expect(() => changed({ accountId: "999999999999" })).toThrow(
    "another deployment account",
  );
  expect(
    changed({
      released:
        "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@sha256:" +
        "c".repeat(64),
      acceptableDigests: [webDigest, "sha256:" + "c".repeat(64)],
    }),
  ).toContain("The released image changed during the journey");
  expect(
    changed({
      services: [service({ taskArns: ["task-a", "task-z"] }), worker()],
    }),
  ).toContain(
    "The one-door-personal-web tasks were replaced during the journey",
  );
  expect(() =>
    changed({ services: [service({ tasks: 3 }), worker()] }),
  ).toThrow("is not usable");
  expect(
    finalize({
      environment: "personal",
      origin: "https://example.cloudfront.net",
      result,
      before: snapshot({ verifiedAt: "2026-09-08T00:01:00.000Z" }),
      after,
    }).unverified,
  ).toContain("The first observation is not before the journey started");
  expect(
    finalize({
      environment: "personal",
      origin: "https://example.cloudfront.net",
      result,
      before: snapshot(),
      after: snapshot(),
    }).unverified,
  ).toContain("The second observation is not after the journey finished");
});

it("refuses a release verification that is missing or malformed", () => {
  const result = browserResult({
    facts: facts(),
    receipts: completedCalls(),
    costAllowance: 200_000,
  });
  const refuse = (over: Record<string, unknown>) => () =>
    finalize({
      environment: "personal",
      origin: "https://example.cloudfront.net",
      result,
      before: snapshot(over),
      after: snapshot(over),
    });
  expect(refuse({ released: undefined })).toThrow("is not usable");
  expect(refuse({ released: "one-door:latest" })).toThrow(
    "immutable image reference",
  );
  expect(refuse({ verifiedAt: "not a time" })).toThrow("is not usable");
  expect(refuse({ accountId: "84519182674" })).toThrow("is not usable");
  expect(refuse({ services: [service()] })).toThrow("is not usable");
  expect(refuse({ services: [service(), service()] })).toThrow(
    "must cover exactly one-door-personal-web and one-door-personal-worker",
  );
  expect(
    refuse({ services: [service({ healthVerified: false }), worker()] }),
  ).toThrow("is not usable");
  expect(
    refuse({ services: [service({ taskArns: ["task-a"] }), worker()] }),
  ).toThrow("is not usable");
  expect(
    refuse({
      services: [service({ taskArns: ["task-a", "task-a"] }), worker()],
    }),
  ).toThrow("tasks are not distinct");
  expect(
    refuse({
      services: [service({ digests: ["sha256:" + "e".repeat(64)] }), worker()],
    }),
  ).toThrow("which the released image does not cover");
  expect(refuse({ acceptableDigests: ["sha256:" + "f".repeat(64)] })).toThrow(
    "does not accept its own released digest",
  );
  expect(
    refuse({
      services: [service(), worker({ workerProgressVerified: undefined })],
    }),
  ).toThrow("does not affirm worker progress");
  expect(
    refuse({ services: [service(), worker({ workerProgress: undefined })] }),
  ).toThrow("lacks progress evidence for every task");
});

it("rejects worker progress that does not cover both verified tasks", () => {
  const result = browserResult({
    facts: facts(),
    receipts: completedCalls(),
    costAllowance: 200_000,
  });
  const progress = ["task-c", "task-c"].map((taskArn) => ({
    taskArn,
    lastSuccessfulPollAt: 1000,
    logTimestamp: 1000,
  }));
  expect(() =>
    finalize({
      environment: "personal",
      origin: "https://example.cloudfront.net",
      result,
      before: snapshot(),
      after: snapshot({
        services: [service(), worker({ workerProgress: progress })],
      }),
    }),
  ).toThrow("lacks progress evidence for every task");
});

it("finalizes only the operator-selected Truss account, origin and services", () => {
  const origin = "https://one-door.sandbox.truss.coffee";
  const result = browserResult({
    facts: facts({ origin }),
    receipts: completedCalls(),
    costAllowance: 200_000,
  });
  const trussSnapshot = (over: Record<string, unknown> = {}) => {
    const value = JSON.parse(
      JSON.stringify(snapshot(over))
        .replaceAll("845191826742", "004351505091")
        .replaceAll("one-door-personal", "one-door-truss"),
    );
    return { ...value, origin };
  };
  const before = trussSnapshot();
  const after = trussSnapshot({ verifiedAt: "2026-09-08T00:06:00.000Z" });
  const selected = { environment: "truss", origin, result, before, after };
  expect(finalize(selected).status).toBe("complete");
  expect(() => finalize({ ...selected, before: snapshot() })).toThrow(
    "another deployment account",
  );
  expect(() => finalize({ ...selected, after: snapshot() })).toThrow(
    "another deployment account",
  );
  expect(() =>
    finalize({ ...selected, before: { ...before, released } }),
  ).toThrow("outside the selected deployment");
  expect(() =>
    finalize({
      ...selected,
      before: { ...before, services: [service(), worker()] },
    }),
  ).toThrow("must cover exactly one-door-truss-web and one-door-truss-worker");
  expect(() =>
    finalize({
      ...selected,
      after: { ...after, origin: "https://example.cloudfront.net" },
    }),
  ).toThrow("another application origin");
  expect(() =>
    finalize({ ...selected, origin: "https://other.sandbox.truss.coffee" }),
  ).toThrow("selected application origin is invalid");
});

it("keeps failed automatic asset preparation visible in the journey result", () => {
  const input = facts();
  input.jobs.asset_match = { jobId: "job-2", status: "failed" };
  expect(
    browserResult({
      facts: input,
      receipts: completedCalls(),
      costAllowance: 200_000,
    }).unverified,
  ).toContain("The asset_match job settled as failed");
});

it("accepts reused intake assets without inventing a separate asset job", () => {
  const reused = facts();
  reused.jobs.asset_match = null;
  const result = browserResult({
    facts: reused,
    receipts: completedCalls(),
    costAllowance: 200_000,
  });
  expect(result.unverified).toEqual([
    "Pending operator finalization against the deployed release",
  ]);
  reused.assetResult = null;
  expect(
    browserResult({
      facts: reused,
      receipts: completedCalls(),
      costAllowance: 200_000,
    }).unverified,
  ).toContain("No successful current asset assessment was observed");
});

it("rejects an asset result without matching provider evidence", () => {
  const unrelated = facts();
  unrelated.assetResult!.modelCallId = "unrelated-call";
  expect(
    browserResult({
      facts: unrelated,
      receipts: completedCalls(),
      costAllowance: 200_000,
    }).unverified,
  ).toContain("The asset assessment has no successful provider call evidence");
});

it("redacts the demo access code from browser failure evidence and assertion output", () => {
  const code = randomBytes(24).toString("hex");
  expect(
    journeyFailure(new Error(`fill failed for ${code}; retry ${code}`), code),
  ).toBe(
    "fill failed for [redacted access code]; retry [redacted access code]",
  );
  expect(journeyFailure("request timed out", undefined)).toBe(
    "request timed out",
  );
});

it("loads under the strip-only runtime the operator finalizes with", () => {
  const script = `
    const module = await import(${JSON.stringify(new URL("./hosted-journey.ts", import.meta.url).href)});
    const refusal = new module.JourneyRefused("refused");
    if (refusal.reason !== "refused") throw new Error("reason field lost");
    if (refusal.name !== "JourneyRefused") throw new Error("name lost");
    console.log("ok");
  `;
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  expect(result.trim()).toBe("ok");
});
