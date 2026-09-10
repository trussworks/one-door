import assert from "node:assert/strict";

import { isMain } from "../is-main.mjs";
import { aws, AwsError } from "./aws.ts";
import {
  deploymentEnvironment,
  deploymentTarget,
  githubSubject,
} from "./targets.ts";

async function publisherToken(
  expectedSubject: string,
  environment: string,
): Promise<string> {
  const target = deploymentTarget(environment);
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  assert.ok(endpoint && requestToken, "GitHub OIDC request context is missing");
  const url = new URL(endpoint);
  assert.equal(url.protocol, "https:", "GitHub OIDC requires HTTPS");
  url.searchParams.set("audience", "sts.amazonaws.com");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  assert.equal(response.status, 200, "GitHub OIDC token request failed");
  const { value } = (await response.json()) as { value: string };
  assert.equal(typeof value, "string", "GitHub OIDC token is missing");
  let claims;
  try {
    claims = JSON.parse(
      Buffer.from(value.split(".")[1], "base64url").toString(),
    );
  } catch {
    throw new Error("GitHub OIDC token is malformed");
  }
  assert.equal(claims.sub, expectedSubject);
  assert.equal(claims.aud, "sts.amazonaws.com");
  assert.equal(claims.ref, "refs/heads/main");
  assert.equal(claims.repository_id, target.github_repository_id);
  assert.equal(claims.repository_owner_id, target.github_owner_id);
  return value;
}

export async function checkPublishBoundary(
  roleArn: string,
  subject: string,
  account: string,
): Promise<void> {
  const environment = deploymentEnvironment(account);
  const target = deploymentTarget(environment);
  assert.equal(roleArn, `arn:aws:iam::${account}:role/${target.name}-release`);
  assert.equal(subject, githubSubject(environment, true));
  const token = await publisherToken(subject, environment);
  try {
    // Stdin keeps the token out of argv, files and CI output.
    aws(
      [
        "sts",
        "assume-role-with-web-identity",
        "--no-sign-request",
        "--role-arn",
        roleArn,
        "--role-session-name",
        "one-door-publish-boundary",
        "--duration-seconds",
        "900",
        "--web-identity-token",
        "file:///dev/stdin",
      ],
      token,
    );
  } catch (error) {
    if (
      error instanceof AwsError &&
      ["AccessDenied", "AccessDeniedException"].includes(error.code)
    ) {
      console.log("Publisher OIDC context was refused by the deployment role.");
      return;
    }
    throw error;
  }
  throw new Error(
    "Publisher OIDC context unexpectedly assumed the deployment role; release is blocked",
  );
}

if (isMain(import.meta)) {
  const [role, subject, account] = process.argv.slice(2);
  if (!role || !subject || !account)
    throw new Error(
      "Usage: check-publish-boundary.ts DEPLOY_ROLE_ARN PUBLISH_SUBJECT ACCOUNT_ID",
    );
  await checkPublishBoundary(role, subject, account);
}
