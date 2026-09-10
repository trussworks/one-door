import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { isMain } from "../is-main.mjs";
import {
  readPlatform,
  requireAccount,
  resolveTool,
  type Platform,
} from "./aws.ts";
import {
  requireInitializationValues,
  requireSafePlan,
  startInstalledRelease,
} from "./deploy-release.ts";
import { requireInitializationStopped } from "./run-task.ts";
import { parseImageReference } from "./verify-release.ts";
import { checkImageScan } from "./check-image-scan.ts";

function requireInitializationPlan(file: string, p: Platform): string {
  const plan = JSON.parse(
    execFileSync(
      resolveTool("terraform"),
      ["-chdir=infra/release", "show", "-json", file],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  requireInitializationValues(
    Object.fromEntries(
      Object.entries(plan.variables).map(([key, value]) => [
        key,
        (value as { value: unknown }).value,
      ]),
    ),
    p,
  );
  requireSafePlan(plan.resource_changes ?? []);
  const services = plan.planned_values.root_module.resources.filter(
    (resource: { type: string }) => resource.type === "aws_ecs_service",
  );
  assert.deepEqual(
    services
      .map((service: { values: { name: string } }) => service.values.name)
      .sort(),
    [p.name + "-web", p.name + "-worker"].sort(),
    "The installation plan must name exactly the two application services",
  );
  for (const service of services) {
    assert.equal(
      service.values.desired_count,
      0,
      "The installation plan would start public tasks",
    );
    assert.equal(
      service.values.cluster,
      p.cluster_arn,
      "The installation plan uses another cluster",
    );
  }
  return plan.variables.candidate_image.value;
}

export function initializeDeployment(
  platformFile: string,
  action: string,
  input: string,
  planFile?: string,
): void {
  assert.ok(
    action === "plan" || action === "apply",
    "Installation action must be plan or apply",
  );
  const p = readPlatform(platformFile);
  requireAccount(p);
  requireInitializationStopped(p);
  if (action === "plan") {
    assert.ok(planFile, "An installation plan path is required");
    const values = JSON.parse(readFileSync(input, "utf8"));
    requireInitializationValues(values, p);
    checkImageScan(
      p.repository_url,
      p.region,
      parseImageReference(values.candidate_image).digest,
      planFile + ".scan.json",
    );
    execFileSync(
      resolveTool("terraform"),
      [
        "-chdir=infra/release",
        "plan",
        "-input=false",
        "-var-file=" + input,
        "-out=" + planFile,
      ],
      { stdio: "inherit" },
    );
    requireInitializationPlan(planFile, p);
    console.log("Installation plan verified; review it before applying.");
    return;
  }
  const image = requireInitializationPlan(input, p);
  checkImageScan(
    p.repository_url,
    p.region,
    parseImageReference(image).digest,
    input + ".apply-scan.json",
  );
  requireInitializationStopped(p);
  execFileSync(
    resolveTool("terraform"),
    ["-chdir=infra/release", "apply", "-input=false", input],
    { stdio: "inherit" },
  );
  requireInitializationStopped(p);
  console.log(
    "Installation services are confirmed stopped; bootstrap may proceed.",
  );
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const [platform, action, input, planOrDirectory, sourceRevision] = args;
  const expected = { plan: 4, apply: 3, start: 5 }[action];
  if (!platform || !input || args.length !== expected)
    throw new Error(
      "Usage: initialize-deployment.ts PLATFORM_JSON plan VARIABLES_JSON PLAN_FILE | PLATFORM_JSON apply PLAN_FILE | PLATFORM_JSON start RELEASE_JSON PRIVATE_DIRECTORY SOURCE_REVISION",
    );
  if (action === "start") {
    await startInstalledRelease(
      platform,
      input,
      planOrDirectory,
      sourceRevision,
    );
  } else {
    initializeDeployment(platform, action, input, planOrDirectory);
  }
}
