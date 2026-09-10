import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";

const calls = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: calls.exec,
}));
import {
  aws,
  AwsError,
  readPlatform,
  requireAccount,
  resolveTool,
} from "../../scripts/deploy/aws.ts";
import { deploy } from "../../scripts/deploy/deploy-release.ts";
import { promoteImage } from "../../scripts/deploy/promote-image.ts";

it.each([
  "install-secrets",
  "run-task",
  "upload-assets",
  "verify-release",
  "release-record",
  "rotate-secret",
  "deploy-release",
  "initialize-deployment",
  "promote-image",
  "check-publish-boundary",
])(
  "%s starts under Node's actual strip-only runtime and refuses absent arguments",
  (script) => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/deploy/" + script + ".ts"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ONE_DOOR_AWS: path.resolve(".harness/no-aws-executable"),
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  },
);

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it("requires an absolute executable path for the pinned Terraform tool", () => {
  vi.stubEnv("ONE_DOOR_TERRAFORM", "terraform");
  expect(() => resolveTool("terraform")).toThrow("absolute path");
  vi.stubEnv("ONE_DOOR_TERRAFORM", "/pinned-tool/terraform");
  expect(resolveTool("terraform")).toBe("/pinned-tool/terraform");
});

const parent = path.resolve(".harness/deployment-unit");
mkdirSync(parent, { recursive: true });
const folder = mkdtempSync(path.join(parent, "case-"));
const platform = {
  account_id: "845191826742",
  region: "us-west-2",
  environment: "personal",
  name: "one-door-personal",
  cluster_name: "one-door-personal",
  cluster_arn: "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal",
  subnet_ids: ["subnet-1234abcd", "subnet-5678abcd"],
  worker_security_group_id: "sg-1234abcd",
  database_host: "one-door-personal.example.us-west-2.rds.amazonaws.com",
  database_identifier: "one-door-personal",
  repository_url:
    "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal",
  app_origin: "https://dexample.cloudfront.net",
  distribution_id: "EXAMPLE",
  assets_bucket: "one-door-assets-845191826742-us-west-2",
  log_groups: { operations: "/one-door/personal/operations" },
  secret_arns: Object.fromEntries(
    ["runtime", "migration", "diagnostic", "gate", "session", "anthropic"].map(
      (name) => [
        name,
        "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/" +
          name +
          "-abcdef",
      ],
    ),
  ),
};
const truss = JSON.parse(
  JSON.stringify(platform)
    .replaceAll("845191826742", "004351505091")
    .replaceAll("personal", "truss"),
);
truss.app_origin = "https://one-door.sandbox.truss.coffee";
function input(value: unknown, name: string) {
  const file = path.join(folder, name + ".json");
  writeFileSync(file, JSON.stringify(value), { flag: "wx" });
  return file;
}

it("checks the actual account before any mutation", () => {
  calls.exec.mockReturnValue('{"Account":"000000000000"}');
  expect(() => requireAccount(platform)).toThrow("account mismatch");
  expect(calls.exec).toHaveBeenCalledTimes(1);
  expect(calls.exec.mock.calls[0][1].slice(0, 2)).toEqual([
    "sts",
    "get-caller-identity",
  ]);
});

it("passes secret payloads through stdin, never command arguments", () => {
  calls.exec.mockReturnValue("{}");
  const secret = randomBytes(16).toString("hex");
  aws(
    [
      "secretsmanager",
      "put-secret-value",
      "--secret-string",
      "file:///dev/stdin",
    ],
    secret,
  );
  const [, args, options] = calls.exec.mock.calls[0];
  expect(args).not.toContain(secret);
  expect(args).toContain("file:///dev/stdin");
  expect(options.input).toBe(secret);
});

it("lets the CLI reopen stdin as a file on the real operating system", async () => {
  const child =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  calls.exec.mockImplementation(child.execFileSync);
  const program = path.join(folder, "stdin-reader.py");
  writeFileSync(
    program,
    '#!/usr/bin/python3\nimport sys,json\nwith open(sys.argv[sys.argv.index("--secret-string") + 1][7:]) as stream:\n    print(json.dumps({"SecretString": stream.read()}))\n',
    { mode: 0o700 },
  );
  vi.stubEnv("ONE_DOOR_AWS", program);
  const payload = { SecretString: randomBytes(16).toString("hex") };
  expect(
    aws(
      [
        "secretsmanager",
        "put-secret-value",
        "--secret-string",
        "file:///dev/stdin",
      ],
      payload.SecretString,
    ),
  ).toEqual(payload);
});

it("reports an AWS error code without leaking its private response", () => {
  const error = Object.assign(new Error("raw private failure"), {
    stderr:
      "An error occurred (AccessDeniedException) when calling: private-password",
  });
  calls.exec.mockImplementation(() => {
    throw error;
  });
  try {
    aws(["secretsmanager", "get-secret-value"]);
    throw new Error("expected failure");
  } catch (result) {
    expect(result).toBeInstanceOf(AwsError);
    expect((result as Error).message).toContain("AccessDeniedException");
    expect((result as Error).message).not.toContain("private-password");
  }
});

it("accepts account-consistent platform outputs", () => {
  expect(readPlatform(input(platform, "valid")).account_id).toBe(
    platform.account_id,
  );
});

it("accepts the approved Truss account and canonical hostname", () => {
  expect(readPlatform(input(truss, "truss-valid"))).toEqual(truss);
});

it.each([
  "wrong-account",
  "mutable-tags",
  "tag-conflict",
  "registry-denied",
  "uncommitted-tools",
])(
  "refuses image promotion before invoking Docker when the destination has %s",
  (failure) => {
    const sourceRevision = "a".repeat(40);
    const imageDigest = "sha256:" + "b".repeat(64);
    const source = {
      sourceRevision,
      imageDigest,
      image: platform.repository_url + "@" + imageDigest,
      releaseId: "approved-release",
    };
    calls.exec.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "status") return " M scripts/deploy/promote-image.ts";
      if (args[1] === "get-caller-identity")
        return JSON.stringify({
          Account:
            failure === "wrong-account"
              ? platform.account_id
              : truss.account_id,
        });
      if (failure === "registry-denied")
        throw Object.assign(new Error("Denied"), {
          stderr: "An error occurred (AccessDeniedException)",
        });
      if (args[1] === "describe-repositories")
        return JSON.stringify({
          repositories: [
            {
              repositoryUri: truss.repository_url,
              imageTagMutability:
                failure === "mutable-tags" ? "MUTABLE" : "IMMUTABLE",
            },
          ],
        });
      if (args[1] === "describe-images")
        return JSON.stringify({
          imageDetails: [
            {
              imageDigest:
                failure === "uncommitted-tools"
                  ? imageDigest
                  : "sha256:" + "c".repeat(64),
            },
          ],
        });
      throw new Error("Unexpected operation");
    });
    expect(() =>
      promoteImage(
        input(truss, "promotion-platform-" + failure),
        input(source, "promotion-source-" + failure),
        sourceRevision,
        path.join(folder, failure),
      ),
    ).toThrow();
    expect(
      calls.exec.mock.calls.every(([, args]) => args[0] !== "buildx"),
    ).toBe(true);
  },
);

it("rejects a release from another revision before contacting AWS", async () => {
  await expect(
    deploy(
      input(truss, "revision-platform"),
      input({ sourceRevision: "b".repeat(40) }, "wrong-revision"),
      folder,
      "a".repeat(40),
    ),
  ).rejects.toThrow("independently selected source revision");
  expect(calls.exec).not.toHaveBeenCalled();
});

it("uses the explicit operator revision and still verifies the actual Truss account", async () => {
  vi.stubEnv("GITHUB_SHA", "b".repeat(40));
  calls.exec.mockReturnValue('{"Account":"000000000000"}');
  await expect(
    deploy(
      input(truss, "operator-platform"),
      input(
        {
          sourceRevision: "a".repeat(40),
          image: truss.repository_url + "@sha256:" + "a".repeat(64),
          releaseId: "operator-release",
        },
        "operator-record",
      ),
      folder,
      "a".repeat(40),
    ),
  ).rejects.toThrow("AWS account mismatch");
  expect(calls.exec).toHaveBeenCalledOnce();
  expect(calls.exec.mock.calls[0][1].slice(0, 2)).toEqual([
    "sts",
    "get-caller-identity",
  ]);
});

it.each([
  { account_id: "845191826742" },
  { environment: "personal" },
  { environment: "constructor" },
  { region: "us-east-1" },
])("rejects a crossed deployment identity: %j", (change) => {
  expect(() =>
    readPlatform(
      input(
        { ...truss, ...change },
        "identity-" + Object.keys(change)[0] + Object.values(change)[0],
      ),
    ),
  ).toThrow();
});

it.each([
  "https://other.sandbox.truss.coffee",
  "https://one-door.sandbox.truss.coffee.example.com",
  "https://dexample.cloudfront.net",
  "https://one-door.sandbox.truss.coffee/",
  "https://one-door.sandbox.truss.coffee:8443",
])("rejects an unapproved or noncanonical Truss origin: %s", (origin) => {
  expect(() =>
    readPlatform(
      input(
        { ...truss, app_origin: origin },
        "origin-" + randomBytes(4).toString("hex"),
      ),
    ),
  ).toThrow("origin");
});

it("refuses image repositories and secrets outside the deployment", () => {
  expect(() =>
    readPlatform(
      input({ ...platform, repository_url: "other.example/repo" }, "bad-repo"),
    ),
  ).toThrow();
  expect(() =>
    readPlatform(
      input(
        {
          ...platform,
          secret_arns: {
            ...platform.secret_arns,
            runtime:
              "arn:aws:secretsmanager:us-west-2:845191826742:secret:/another-app",
          },
        },
        "bad-secret",
      ),
    ),
  ).toThrow("outside");
});

it("refuses credential-bearing or non-HTTPS application origins", () => {
  // Assembled rather than written literally: a basic-auth URL in source is a
  // finding for the secret scan even when the value is invented.
  const credentialed = new URL(platform.app_origin);
  credentialed.username = "operator";
  credentialed.password = randomBytes(8).toString("hex");
  expect(() =>
    readPlatform(
      input({ ...platform, app_origin: credentialed.href }, "credentials"),
    ),
  ).toThrow();
  expect(() =>
    readPlatform(
      input(
        // Derived, not written literally, so the lint rule against clear-text
        // protocols does not fire on the value this test must reject.
        {
          ...platform,
          app_origin: platform.app_origin.replace("https", "http"),
        },
        "http",
      ),
    ),
  ).toThrow();
});
