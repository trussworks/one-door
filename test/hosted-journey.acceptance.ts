// One deliberate acceptance journey against a deployed origin. It dispatches
// real provider work and spends from the demo caps real visitors share, so an
// operator runs it on purpose and never as part of routine checks.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import {
  browserResult,
  callReceipts,
  checkQuota,
  journeyFailure,
  requireCount,
  requireHeadroom,
  type CallReceipt,
  type JourneyFacts,
} from "./hosted-journey.ts";

const settled = ["succeeded", "failed", "capped", "superseded"];
const isSettled = new RegExp("^(" + settled.join("|") + ")$");

const costAllowance = requireCount(
  Number(process.env.ONE_DOOR_SMOKE_MAX_MICROS),
  "ONE_DOOR_SMOKE_MAX_MICROS",
);
const runId =
  new Date().toISOString().replace(/[:.]/g, "-") +
  "-" +
  randomBytes(4).toString("hex");

// Obviously invented, and complete enough that intake can produce a
// submittable record without asking for facts nobody can supply. It states who
// does the work, the conditions, the information involved and what success
// looks like. The text never reaches the receipt.
const need = [
  "Acceptance rehearsal for the Bureau of Imaginary Affairs.",
  "Two kettle inspectors visit village halls each weekday and record what they find on paper forms.",
  "The halls have no reliable mobile signal, so inspectors write notes during the visit and type them up that evening.",
  "Each inspection records the hall name, the visit date, the inspector, the kettle serial number, a pass or fail result, and a short note.",
  "Typed-up notes are emailed to one clerk who copies them into a spreadsheet, and about one in ten arrives too late to include in the weekly count.",
  "Success is that every completed inspection appears in the weekly count on the Monday after the visit, without the clerk retyping anything.",
  "Inspectors keep using their own phones and the service must work with no signal during a visit.",
].join(" ");

type Workspace = { job: { jobId: string; status: string } | null };
type View = {
  currentJobs: Record<string, { jobId: string; status: string } | null>;
  assetAssessment: JourneyFacts["assetResult"];
  riskAssessment: { id: string; status: string } | null;
  evidence: { calls: unknown };
};

async function readJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (target) => {
    const response = await fetch(target);
    if (!response.ok)
      throw new Error(target + " read failed: " + response.status);
    return response.json();
  }, path);
}

async function enter(page: Page) {
  const code = process.env.DEMO_ACCESS_CODE;
  if (!code) throw new Error("DEMO_ACCESS_CODE is required");
  await page.goto("/my");
  await page.getByLabel("Demo access code").fill(code);
  await page
    .getByRole("button", { name: "Enter the demo", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "My requests", exact: true }),
  ).toBeVisible();
}

async function draftAndInterpret(page: Page, facts: JourneyFacts) {
  await page.goto("/new");
  await page.getByLabel("What do you need to accomplish?").fill(need);
  await page
    .getByLabel("Requesting agency or office")
    .selectOption({ label: "Budget Office" });
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page).toHaveURL(/draft=/);
  facts.draftId = new URL(page.url()).searchParams.get("draft");
  const workspace = () =>
    readJson<Workspace>(page, "/api/intake-workspace/" + facts.draftId);
  await expect
    .poll(async () => (await workspace()).job?.status ?? "queued", {
      timeout: 240000,
    })
    .toMatch(isSettled);
  facts.jobs.intake_interpret = (await workspace()).job;
}

async function submitRequest(page: Page, facts: JourneyFacts) {
  await page.getByRole("radio", { name: "4", exact: true }).check();
  const submission = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/intake-workspace" &&
      response.request().postDataJSON()?.action === "submit",
  );
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  const response = await submission;
  expect(response.status()).toBe(200);
  const request = (await response.json()) as {
    requestId: string;
    displayId: string;
  };
  facts.requestId = request.requestId;
  facts.displayId = request.displayId;
}

/**
 * The combined intake result can supply assets without a separate job.
 * Require its current assessment, and wait for any queued refresh and risk.
 */
async function awaitPreparation(page: Page, facts: JourneyFacts) {
  const view = () =>
    readJson<View>(page, "/api/request-view/" + facts.requestId);
  for (const purpose of ["asset_match", "risk_assess"] as const)
    await expect
      .poll(
        async () => {
          const current = await view();
          return (
            current.currentJobs[purpose]?.status ??
            (purpose === "asset_match"
              ? current.assetAssessment?.status
              : undefined) ??
            "queued"
          );
        },
        {
          timeout: 300000,
        },
      )
      .toMatch(isSettled);
  const assessed = await view();
  facts.jobs.asset_match = assessed.currentJobs.asset_match ?? null;
  facts.assetResult = assessed.assetAssessment;
  facts.jobs.risk_assess = assessed.currentJobs.risk_assess;
  // Reload rather than re-render: the result has to have been persisted.
  await page.goto("/review/" + facts.requestId + "?section=risk");
  await page.reload();
  await expect(page.locator("#risk")).toBeVisible();
  const reloaded = await view();
  facts.persistedAfterReload = assessmentsPersisted(assessed, reloaded);
  return callReceipts(reloaded.evidence.calls);
}

function assessmentsPersisted(assessed: View, reloaded: View): boolean {
  return (
    (["assetAssessment", "riskAssessment"] as const).every(
      (name) =>
        reloaded[name]?.status === "succeeded" &&
        reloaded[name]?.id === assessed[name]?.id,
    ) &&
    reloaded.currentJobs.risk_assess?.jobId ===
      assessed.currentJobs.risk_assess?.jobId
  );
}

function save(result: ReturnType<typeof browserResult>) {
  const root = process.env.ONE_DOOR_SMOKE_EVIDENCE_DIR;
  if (!root) throw new Error("ONE_DOOR_SMOKE_EVIDENCE_DIR is required");
  const directory = join(root, runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "hosted-journey-receipt.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "Hosted acceptance receipt:",
    join(directory, "hosted-journey-receipt.json"),
  );
}

test("the running release interprets, assesses and persists one real request", async ({
  page,
}) => {
  const facts: JourneyFacts = {
    origin: process.env.E2E_BASE_URL!,
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    draftId: null,
    requestId: null,
    displayId: null,
    jobs: {},
    assetResult: null,
    persistedAfterReload: false,
    failure: null,
  };
  let receipts: CallReceipt[] = [];
  try {
    await enter(page);
    requireHeadroom(
      checkQuota(
        (await readJson<{ quota: unknown }>(page, "/api/reports")).quota,
      ),
      costAllowance,
    );
    await draftAndInterpret(page, facts);
    await submitRequest(page, facts);
    receipts = await awaitPreparation(page, facts);
  } catch (caught) {
    facts.failure = journeyFailure(caught, process.env.DEMO_ACCESS_CODE);
    // The request and its calls are retained, so the receipt has to name them
    // even when the journey fails; otherwise the retained work is unfindable.
    if (facts.requestId)
      receipts = await readJson<View>(
        page,
        "/api/request-view/" + facts.requestId,
      )
        .then((view) => callReceipts(view.evidence.calls))
        .catch(() => receipts);
  } finally {
    facts.finishedAt = new Date().toISOString();
    save(browserResult({ facts, receipts, costAllowance }));
  }
  expect(facts.failure, facts.failure ?? "").toBeNull();
  const result = browserResult({ facts, receipts, costAllowance });
  expect(
    result.unverified.filter(
      (reason) =>
        reason !== "Pending operator finalization against the deployed release",
    ),
    result.unverified.join("; "),
  ).toEqual([]);
});
