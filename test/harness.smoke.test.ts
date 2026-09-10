import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { buildSeedData } from "../src/seed/build.ts";

it("retains accessibility review reports even when browser checks pass", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/harness-ci.yml", import.meta.url),
    "utf8",
  );
  const browser = workflow
    .split("\n  browser:\n")[1]
    .split("\n  container:\n")[0];
  const upload = browser
    .split("- name: Retain accessibility reports")[1]
    .split("\n      - ")[0];
  expect(upload).toContain("if: always()");
  expect(upload).toContain("name: accessibility-reports");
  expect(upload).toContain("path: playwright-results/**/*-accessibility.json");
});

describe("seed data", () => {
  it("builds a deterministic, connected fixture graph", () => {
    const first = buildSeedData();
    const second = buildSeedData();

    expect(first).toEqual(second);

    expect({
      organizations: first.organizations.length,
      serviceOfferings: first.serviceOfferings.length,
      catalogItems: first.catalogItems.length,
      policyRules: first.policyRules.length,
      requests: first.requests.length,
      taskCompletions: first.taskCompletions.length,
    }).toEqual({
      organizations: 23,
      serviceOfferings: 12,
      catalogItems: 55,
      policyRules: 20,
      requests: 29,
      taskCompletions: 37,
    });

    const draftIds = new Set(first.drafts.map((draft) => draft.id));
    const requestIds = new Set(first.requests.map((request) => request.id));
    expect(
      first.requests.every((request) => draftIds.has(request.sourceDraftId)),
    ).toBe(true);
    expect(
      first.taskCompletions.every((completion) =>
        requestIds.has(completion.requestId),
      ),
    ).toBe(true);
    expect(
      first.taskCompletions.every(
        (completion) => completion.origin === "fixture",
      ),
    ).toBe(true);
  });
});
