import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workflow = () =>
  readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );

const job = (name: string): string => {
  const text = workflow();
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `${name} job is missing`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

it("publishes and deploys under different OIDC subjects and roles", () => {
  const publish = job("publish");
  const deploy = job("deploy");
  expect(publish).toContain("environment: truss-publish");
  expect(deploy).toContain("environment: truss");
  expect(deploy).not.toContain("environment: truss-publish");
  const subject = (text: string) =>
    /EXPECTED_SUBJECT: (\S+)/.exec(text)?.[1] ?? "";
  expect(subject(publish)).toBe(
    "repo:trussworks@1649505/one-door@1362084625:environment:truss-publish",
  );
  expect(subject(deploy)).toBe(
    "repo:trussworks@1649505/one-door@1362084625:environment:truss",
  );
  // Identical subjects would let a compromised publish job assume the
  // deployment role, which is the whole point of the separation.
  expect(subject(publish)).not.toBe(subject(deploy));
  expect(publish).toContain("role-to-assume: ${{ vars.AWS_PUBLISH_ROLE_ARN }}");
  expect(deploy).toContain("role-to-assume: ${{ vars.AWS_ROLE_ARN }}");
});

it("checks the trusted claims in both jobs without printing the token", () => {
  for (const text of [job("publish"), job("deploy")]) {
    expect(text).toContain(
      "assert.equal(claims.sub, process.env.EXPECTED_SUBJECT)",
    );
    expect(text).toContain("assert.equal(claims.aud, 'sts.amazonaws.com')");
    expect(text).toContain("assert.equal(claims.ref, 'refs/heads/main')");
    expect(text).toContain("assert.equal(claims.repository_id, '1362084625')");
    expect(text).toContain(
      "assert.equal(claims.repository_owner_id, '1649505')",
    );
    expect(text).not.toMatch(/console\.log\([^)]*\bvalue\b/);
  }
});

it("keeps deployment work out of the publishing job", () => {
  const publish = job("publish");
  expect(publish).not.toContain("deploy-release.ts");
  expect(publish).not.toContain("DEPLOYMENT_PLATFORM");
  expect(publish).not.toContain("terraform");
});

it("offers no first-install route from the workflow", () => {
  const text = workflow();
  expect(text).not.toContain("INITIAL_DEPLOYMENT");
  expect(text).not.toContain("DEPLOYMENT_MODE");
  expect(text).not.toContain("initialize");
  expect(job("deploy")).toContain('"$RUNNER_TEMP/deployment" "$GITHUB_SHA"');
});

it("updates dependencies weekly, in bounded batches, without merging them", () => {
  const config = readFileSync(
    new URL("../../.github/dependabot.yml", import.meta.url),
    "utf8",
  );
  const blocks = config.split("- package-ecosystem:").slice(1);
  expect(blocks.map((block) => block.split("\n")[0].trim())).toEqual([
    "npm",
    "docker",
    "github-actions",
  ]);
  for (const block of blocks) {
    expect(block).toContain("interval: weekly");
    const limit = Number(/open-pull-requests-limit: (\d+)/.exec(block)?.[1]);
    // An unbounded batch would bury the running demo's own release checks.
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(5);
  }
  // A merged update would reach the personal account without a reviewed release.
  expect(config).not.toContain("automerge");
  expect(config).not.toContain("auto-merge");
});
