import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { aws, AwsError, readPlatform, type Platform } from "./aws.ts";
import { isMain } from "../is-main.mjs";

export function checkReleaseBoundary(
  p: Pick<Platform, "account_id" | "region" | "name" | "secret_arns">,
) {
  const identity = aws<{ Account: string; Arn: string }>([
    "sts",
    "get-caller-identity",
    "--region",
    p.region,
  ]);
  assert.equal(identity.Account, p.account_id);
  assert.ok(
    identity.Arn.startsWith(
      `arn:aws:sts::${p.account_id}:assumed-role/${p.name}-release/`,
    ),
    "Run the boundary check with the deployment role",
  );
  const checks = Object.fromEntries(
    ["bootstrap", "platform", "install"].map((stack) => [
      `${stack} state`,
      [
        "s3api",
        "get-object",
        "--bucket",
        `one-door-state-${p.account_id}-${p.region}`,
        "--key",
        `${stack}/terraform.tfstate`,
        "--range",
        "bytes=0-0",
        "/dev/null",
      ],
    ]),
  );
  assert.ok(p.secret_arns.runtime, "Runtime secret reference is missing");
  checks["runtime secret"] = [
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    p.secret_arns.runtime,
  ];
  const denied = [];
  for (const [name, command] of Object.entries(checks)) {
    try {
      // Discard any unexpected successful response; it could contain a secret.
      aws([...command, "--region", p.region]);
    } catch (error) {
      if (
        error instanceof AwsError &&
        ["AccessDenied", "AccessDeniedException"].includes(error.code)
      ) {
        denied.push(name);
        continue;
      }
      throw error;
    }
    throw new Error(`Deployment role unexpectedly read ${name}`);
  }
  return { verifiedAt: new Date().toISOString(), identity, denied };
}

if (isMain(import.meta)) {
  const [platformFile, outputFile] = process.argv.slice(2);
  if (!platformFile || !outputFile || process.argv.length !== 4)
    throw new Error(
      "Usage: check-release-boundary.ts PLATFORM_JSON OUTPUT_JSON",
    );
  const result = checkReleaseBoundary(readPlatform(platformFile));
  writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    "Deployment role cannot read protected state or the runtime database secret.",
  );
}
