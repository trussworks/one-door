import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  releaseSettings,
  requireRunningRelease,
  requireSafePlan,
  deploy,
} from "../../scripts/deploy/deploy-release.ts";

it("permits task-definition replacement only when the old revision is retained", () => {
  const task = {
    address: 'aws_ecs_task_definition.service["web"]',
    type: "aws_ecs_task_definition",
    change: {
      actions: ["delete", "create"],
      before: { skip_destroy: true },
      after: { skip_destroy: true },
    },
  };
  expect(() => requireSafePlan([task])).not.toThrow();
  expect(() =>
    requireSafePlan([
      { ...task, change: { ...task.change, before: { skip_destroy: false } } },
    ]),
  ).toThrow("remove a resource");
  expect(() =>
    requireSafePlan([
      { ...task, change: { ...task.change, after: { skip_destroy: false } } },
    ]),
  ).toThrow("remove a resource");
});

it("refuses service removal, unrelated infrastructure and unconfirmed actions", () => {
  const service = {
    address: "aws_ecs_service.web",
    type: "aws_ecs_service",
    change: { actions: ["update"], after: {} },
  };
  expect(() => requireSafePlan([service])).not.toThrow();
  expect(() => requireSafePlan([service], true)).toThrow(
    "preparation cannot change a serving service",
  );
  expect(() =>
    requireSafePlan(
      [{ ...service, change: { actions: ["no-op"], after: {} } }],
      true,
    ),
  ).not.toThrow();
  expect(() =>
    requireSafePlan([
      { ...service, change: { actions: ["delete"], after: null } },
    ]),
  ).toThrow("remove a resource");
  expect(() =>
    requireSafePlan([{ ...service, type: "aws_db_instance" }]),
  ).toThrow("unexpected resource");
  expect(() =>
    requireSafePlan([{ ...service, change: { actions: [], after: {} } }]),
  ).toThrow("no confirmed action");
});

it("does not silently resume paused services", () => {
  const current = { web_count: 2, worker_count: 2 } as Parameters<
    typeof requireRunningRelease
  >[0];
  expect(() => requireRunningRelease(current)).not.toThrow();
  const stopped = { ...current, web_count: 0, worker_count: 0 };
  expect(() => requireRunningRelease(stopped)).toThrow(
    "rolling release requires",
  );
  expect(() =>
    requireRunningRelease({ ...current, worker_count: 0 }),
  ).toThrow();
});

it("rejects initialization before reading inputs or touching AWS", async () => {
  await expect(
    deploy(
      "unread-platform",
      "unread-record",
      "unused-directory",
      "initialize",
    ),
  ).rejects.toThrow("operator install procedure");
});

it("deploys only after the source checks and scanned image publish job", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const deploy = workflow.split("  deploy:")[1];
  expect(deploy).toContain("needs: [checks, publish]");
  expect(deploy).toContain('gh run download "$GITHUB_RUN_ID"');
  expect(deploy).toContain('allowed-account-ids: "004351505091"');
  expect(deploy).toContain("environment: truss");
  expect(deploy).toContain(
    "IMAGE_ARTIFACT: ${{ needs.publish.outputs.artifact_name }}",
  );
  expect(workflow).toContain("name: truss-release-image-${{ env.RELEASE_ID }}");
  expect(deploy).toContain("id-token: write");
  expect(deploy).not.toMatch(/aws-access-key-id|aws-secret-access-key/);
  expect(deploy).toContain("scripts/deploy/deploy-release.ts");
});

it("rejects an empty or malformed backend rather than initializing it", () => {
  const initial = { web_count: 0, worker_count: 0 } as Parameters<
    typeof requireRunningRelease
  >[0];
  expect(() => releaseSettings({})).toThrow("operator installation");
  expect(() => releaseSettings({ unrelated: { value: initial } })).toThrow(
    "no settings output",
  );
  const running = { ...initial, web_count: 2, worker_count: 2 };
  expect(releaseSettings({ settings: { value: running } })).toBe(running);
});
