import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ESLint } from "eslint";
import { resolveTool } from "../scripts/deploy/aws.ts";

const readWorkflow = () =>
  readFileSync(
    new URL("../.github/workflows/harness-ci.yml", import.meta.url),
    "utf8",
  );
const readPackage = () =>
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

it("renders direct Node commands for the production Compose processes", () => {
  const config = JSON.parse(
    execFileSync(
      resolveTool("docker"),
      ["compose", "-f", "compose.app.yaml", "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://localhost/one_door_compose",
          DEMO_ACCESS_CODE: randomBytes(12).toString("hex"),
          SESSION_SECRET: randomBytes(32).toString("hex"),
          ANTHROPIC_API_KEY: randomBytes(12).toString("hex"),
          APP_ORIGIN: "https://example.cloudfront.net",
        },
      },
    ),
  );
  expect(config.services.migrate.command).toEqual([
    "node",
    "--experimental-strip-types",
    "scripts/db-migrate.ts",
  ]);
  expect(config.services.worker.command).toEqual([
    "node",
    "--experimental-strip-types",
    "scripts/model-worker.ts",
  ]);
});

it("publishes a Truss image only after all checks, using protected OIDC and immutable inputs", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  expect(workflow).toContain("uses: ./.github/workflows/harness-ci.yml");
  expect(workflow).toMatch(/publish:\n\s+needs: checks/);
  expect(workflow).toContain("environment: truss");
  expect(workflow).toContain('allowed-account-ids: "004351505091"');
  expect(workflow).toContain("cancel-in-progress: false");
  expect(workflow).toContain("persist-credentials: false");
  expect(workflow).toContain("id-token: write");
  expect(workflow).toContain(
    "assert.equal(claims.sub, process.env.EXPECTED_SUBJECT)",
  );
  expect(workflow).toContain("provenance: mode=max");
  expect(workflow).toContain("sbom: true");
  expect(workflow).toContain(
    'scripts/deploy/capture-release.ts "$REPOSITORY@$IMAGE_DIGEST" "$RELEASE_ID" "$GITHUB_SHA"',
  );
  expect(workflow).toContain(
    'scripts/deploy/check-image-scan.ts "$REPOSITORY" "$AWS_REGION" "$IMAGE_DIGEST"',
  );
  expect(workflow.indexOf("scripts/deploy/check-image-scan.ts")).toBeLessThan(
    workflow.indexOf("name: truss-release-image"),
  );
  const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("./"));
  expect(actions.every((name) => /@[a-f\d]{40}$/.test(name))).toBe(true);
  expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY");
  const deploy = workflow.split("  deploy:")[1];
  expect(deploy).toContain('install -d -m 700 "$RUNNER_TEMP/deployment"');
  expect(
    deploy.indexOf("scripts/deploy/check-release-boundary.ts"),
  ).toBeGreaterThan(deploy.indexOf("name: Prepare deployment inputs"));
  expect(
    deploy.indexOf("scripts/deploy/check-release-boundary.ts"),
  ).toBeLessThan(deploy.indexOf("scripts/deploy/deploy-release.ts"));
});

it("runs stateful workflow suites in separate fresh CI databases", () => {
  const workflow = readWorkflow();
  const pkg = readPackage();
  for (const suite of [
    "intake",
    "model",
    "catalog",
    "reset",
    "read-model",
    "review-corrections",
    "delivery-lineage",
    "cache-currency",
    "requester-fit",
    "intake-workspace",
    "admin-notes",
    "lifecycle-fixtures",
    "fixture-upgrade",
    "upgrade-lifecycle",
    "bootstrap",
    "inspect",
  ])
    expect(workflow).toMatch(new RegExp("suite:[\\s\\S]*?" + suite));
  expect(workflow).toContain("npm run test:${{ matrix.suite }}");
  const isolated = workflow
    .split("  isolated-workflows:")[1]
    .split("  browser:")[0];
  expect(isolated).toContain("25432:5432");
  expect(isolated).toContain("@localhost:25432/");
  for (const suite of ["review-inputs", "review-input-queue"])
    expect(isolated).toMatch(
      new RegExp(`suite: ${suite}\\n\\s+database: one_door_review_inputs_ci`),
    );
  for (const [suite, file] of [
    ["intake", "intake"],
    ["model", "model"],
    ["catalog", "catalog"],
    ["reset", "reset-interactions"],
    ["read-model", "read-model"],
    ["review-corrections", "review-corrections"],
    ["delivery-lineage", "delivery-lineage"],
    ["cache-currency", "cache-currency"],
    ["requester-fit", "requester-fit"],
    ["intake-workspace", "intake-workspace"],
    ["admin-notes", "admin-notes"],
    ["lifecycle-fixtures", "lifecycle-fixtures"],
    ["fixture-upgrade", "fixture-upgrade"],
    ["upgrade-lifecycle", "upgrade-lifecycle"],
    ["bootstrap", "db-bootstrap"],
  ])
    expect(pkg.scripts["test:" + suite]).toContain(
      "test/" + file + ".integration.ts",
    );
});

it("runs release checks on Node 24 with full history and per-suite databases", () => {
  const workflow = readWorkflow();
  // The runtime image is Node 24; a Node 22 job is not the release proof.
  expect(workflow).not.toContain('node-version: "22"');
  const checkouts = workflow.match(/actions\/checkout@[a-f\d]{40}/g) ?? [];
  expect(checkouts.length).toBeGreaterThan(0);
  expect(workflow.match(/fetch-depth: 0/g) ?? []).toHaveLength(
    checkouts.length,
  );
  for (const [suite, database] of [
    ["admin-notes", "one_door_admin_notes"],
    ["lifecycle-fixtures", "one_door_lifecycle"],
    ["fixture-upgrade", "one_door_fixup"],
    ["upgrade-lifecycle", "one_door_upgrade_lifecycle"],
  ])
    expect(workflow).toMatch(
      new RegExp(`suite: ${suite}\\n\\s+database: ${database}`),
    );
});

it("runs browser journeys against a production app and isolated database in CI", () => {
  const browser = readWorkflow().split("  browser:")[1];
  expect(browser).toContain("-e POSTGRES_DB=one_door_e2e");
  expect(browser).toContain("E2E_DATABASE_URL=postgresql://");
  expect(browser).toContain("npx playwright install --with-deps chromium");
  expect(browser).toMatch(/npm run build[\s\S]*npm run test:browser/);
  expect(browser).not.toContain("ANTHROPIC_API_KEY");
});

it("ignores generated browser artifacts while linting application and test source", async () => {
  const lint = new ESLint();
  expect(await lint.isPathIgnored("playwright-results/example/trace.js")).toBe(
    true,
  );
  expect(await lint.isPathIgnored("src/ui/intake.tsx")).toBe(false);
  expect(await lint.isPathIgnored("test/browser.acceptance.ts")).toBe(false);
});

it("verifies the packaged production image without supplying model credentials", () => {
  const workflow = readWorkflow();
  const container = workflow.split("  container:")[1];
  expect(container).toContain("-e POSTGRES_DB=one_door_container");
  expect(container).toMatch(/docker build[\s\S]*npm run test:container/);
  expect(container).not.toContain("ANTHROPIC_API_KEY");
  expect(container).toContain("npm run test:worker-shutdown");
  expect(container).toContain("createdb -U one_door one_door_shutdown");
  expect(container).toContain("@localhost:25432/one_door_shutdown");
  expect(container).toContain(
    "postgresql://one_door:${{ env.LOCAL_DATABASE_PASSWORD }}@host.docker.internal:25432/one_door_container",
  );
  expect(container.split("    steps:")[0]).not.toContain("${{ env.");
  expect(container).toMatch(
    /- run: npm run test:container\n\s+env:\n[\s\S]*?CONTAINER_DATABASE_URL:/,
  );
  // The build args and the step env must agree, or the label check compares
  // an image built without them against values the test process does have.
  expect(container).toContain("--build-arg SOURCE_REVISION=${{ github.sha }}");
  expect(container).toContain("SOURCE_REVISION: ${{ github.sha }}");
  expect(container).toContain(
    "--build-arg SOURCE_URL=${{ github.server_url }}/${{ github.repository }}",
  );
  expect(container).toContain(
    "SOURCE_URL: ${{ github.server_url }}/${{ github.repository }}",
  );
  expect(
    container.match(
      /ci-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g,
    ),
  ).toHaveLength(2);
  const ignore = readFileSync(
    new URL("../.dockerignore", import.meta.url),
    "utf8",
  );
  // Terraform state, provider plugins and operator tooling must not reach a
  // build context that ships to two accounts' image repositories.
  for (const excluded of [
    ".env*",
    ".entire",
    ".deployment-private",
    "infra",
    "scripts/deploy",
    "test",
    "design",
  ])
    expect(ignore.split("\n")).toContain(excluded);
});

it("installs hooks in a checkout and skips non-Git image stages", () => {
  const pkg = readPackage();
  const root = mkdtempSync(join(tmpdir(), "one-door-install-hooks-"));
  try {
    execFileSync("/bin/sh", ["-c", pkg.scripts.prepare], { cwd: root });
    execFileSync("/usr/bin/git", ["init", "-q", root]);
    execFileSync("/bin/sh", ["-c", pkg.scripts.prepare], { cwd: root });
    const hooks = execFileSync("/usr/bin/git", ["config", "core.hooksPath"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(hooks.trim()).toBe(".githooks");
  } finally {
    rmSync(root, { recursive: true });
  }
});

it("initializes runtime credentials before use and fetches checkpoint history", () => {
  const workflow = readWorkflow();
  expect(workflow).not.toContain("steps.db.outputs.password");
  expect(workflow).not.toContain("$GITHUB_OUTPUT");
  // Every database job generates its own credential in the run and never
  // derives one from predictable run metadata.
  expect(workflow).not.toMatch(/fixture-\$\{\{ github\.run_id \}\}/);
  expect(workflow.match(/openssl rand -hex 24/g)).toHaveLength(4);
  expect(workflow.match(/::add-mask::/g)).toHaveLength(4);
  expect(workflow.match(/>> "\$GITHUB_ENV"/g)).toHaveLength(4);
  expect(workflow.match(/pg_isready[^\n]+&& exit 0/g)).toHaveLength(4);
  expect(workflow.match(/done\n\s+exit 1/g)).toHaveLength(4);
  const credentialJob = workflow
    .split("  credentials:")[1]
    .split("  # harness:")[0];
  expect(credentialJob).toContain(
    "+refs/entire/checkpoints/*:refs/entire/checkpoints/*",
  );
  expect(credentialJob).toContain("credential.helper=!gh auth git-credential");
  expect(credentialJob).toContain("GH_TOKEN: ${{ github.token }}");
  expect(credentialJob.indexOf("Fetch checkpoint history")).toBeLessThan(
    credentialJob.indexOf("npm run security:history"),
  );
});

it("requires the database password from the environment and matches its healthcheck", () => {
  const compose = readFileSync(
    new URL("../compose.yaml", import.meta.url),
    "utf8",
  );
  expect(compose).toContain(
    "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in the local environment.}",
  );
  // The healthcheck must resolve the same user the server is started with.
  const user = compose.match(/POSTGRES_USER: (\S+)/)?.[1];
  expect(user).toBe("${POSTGRES_USER:-one_door}");
  expect(compose).toContain("pg_isready -U ${POSTGRES_USER:-one_door}");
});

it("runs the full check suite only through a manually dispatched release", () => {
  const release = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const harness = readWorkflow();
  expect(release).toContain("uses: ./.github/workflows/harness-ci.yml");
  expect(release).toContain(
    "SOURCE_URL=${{ github.server_url }}/${{ github.repository }}",
  );
  expect(release).toContain("workflow_dispatch:");
  expect(harness).toContain("workflow_call:");
  for (const workflow of [release, harness])
    expect(
      workflow
        .split("jobs:")[0]
        .split("\n")
        .some((line) =>
          /^(push|pull_request|pull_request_target|schedule):/.test(
            line.trim(),
          ),
        ),
    ).toBe(false);
  expect(harness.split("jobs:")[0]).not.toContain("workflow_dispatch:");
  // Publishing and deploying wait for the checks, and both stay pinned to the
  // branch the release role trusts.
  expect(release).toMatch(/publish:\n\s+needs: checks/);
  expect(release).toMatch(/deploy:\n\s+needs: \[checks, publish\]/);
  expect(release).toContain("assert.equal(claims.ref, 'refs/heads/main')");
  const bootstrap = readFileSync(
    new URL("../infra/bootstrap/main.tf", import.meta.url),
    "utf8",
  );
  // The Terraform trust policy and the workflow claim must name one branch;
  // changing either alone leaves the deployment unable to assume its role.
  const releaseBranch = bootstrap.slice(
    bootstrap.indexOf('variable "release_branch"'),
  );
  expect(releaseBranch.slice(0, releaseBranch.indexOf("}"))).toContain(
    'default = "main"',
  );
  expect(bootstrap).toContain(
    '"token.actions.githubusercontent.com:ref" = "refs/heads/${var.release_branch}"',
  );
});
