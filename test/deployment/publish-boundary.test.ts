import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ aws: vi.fn() }));
vi.mock("../../scripts/deploy/aws.ts", async (original) => ({
  ...(await original<typeof import("../../scripts/deploy/aws.ts")>()),
  aws: mocked.aws,
}));
import { AwsError } from "../../scripts/deploy/aws.ts";
import { checkPublishBoundary } from "../../scripts/deploy/check-publish-boundary.ts";

const account = "845191826742";
const role = `arn:aws:iam::${account}:role/one-door-personal-release`;
const subject =
  "repo:rswerve@8964335/one-door@1354631764:environment:personal-publish";
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function identity(changes: Record<string, string> = {}) {
  const claims = {
    sub: subject,
    aud: "sts.amazonaws.com",
    ref: "refs/heads/main",
    repository_id: "1354631764",
    repository_owner_id: "8964335",
    ...changes,
  };
  const token = [
    randomBytes(12).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    randomBytes(12).toString("base64url"),
  ].join(".");
  vi.stubEnv(
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "https://example.actions.githubusercontent.com/token",
  );
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", randomBytes(20).toString("hex"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status: 200, json: async () => ({ value: token }) })),
  );
  return token;
}

it("requires a real STS denial and passes the web token only through stdin", async () => {
  const token = identity();
  mocked.aws.mockImplementation(() => {
    throw new AwsError("AccessDenied", "sts assume-role-with-web-identity");
  });
  await expect(
    checkPublishBoundary(role, subject, account),
  ).resolves.toBeUndefined();
  const [args, input] = mocked.aws.mock.calls[0];
  expect(args).toContain("--no-sign-request");
  expect(args).not.toContain(token);
  expect(args).toContain("--web-identity-token");
  expect(args).not.toContain("--cli-input-json");
  expect(args[args.indexOf("--role-arn") + 1]).toBe(role);
  expect(input).toBe(token);
});

const trussAccount = "004351505091";
const trussRole = `arn:aws:iam::${trussAccount}:role/one-door-truss-release`;
const trussSubject =
  "repo:trussworks@1649505/one-door@1362084625:environment:truss-publish";

it("verifies the independent Truss publisher identity and deployment role", async () => {
  identity({
    sub: trussSubject,
    repository_id: "1362084625",
    repository_owner_id: "1649505",
  });
  mocked.aws.mockImplementation(() => {
    throw new AwsError("AccessDenied", "sts assume-role-with-web-identity");
  });
  await expect(
    checkPublishBoundary(trussRole, trussSubject, trussAccount),
  ).resolves.toBeUndefined();
  expect(mocked.aws.mock.calls[0][0]).toContain(trussRole);
});

it.each([
  { repository_id: "1354631764" },
  { repository_owner_id: "8964335" },
  { sub: subject },
])("rejects a personal identity in the Truss publisher: %j", async (change) => {
  identity({
    sub: trussSubject,
    repository_id: "1362084625",
    repository_owner_id: "1649505",
    ...change,
  });
  await expect(
    checkPublishBoundary(trussRole, trussSubject, trussAccount),
  ).rejects.toThrow();
  expect(mocked.aws).not.toHaveBeenCalled();
});

it("blocks an unexpected successful assumption", async () => {
  identity();
  mocked.aws.mockReturnValue({});
  await expect(checkPublishBoundary(role, subject, account)).rejects.toThrow(
    "unexpectedly assumed",
  );
});

it.each(["ExpiredToken", "InvalidIdentityToken", "COMMAND_FAILED"])(
  "does not misreport %s as proof of the role boundary",
  async (code) => {
    identity();
    mocked.aws.mockImplementation(() => {
      throw new AwsError(code, "sts assume-role-with-web-identity");
    });
    await expect(checkPublishBoundary(role, subject, account)).rejects.toThrow(
      code,
    );
  },
);

it("rejects the wrong branch, subject and role before making the STS request", async () => {
  identity({ ref: "refs/heads/another" });
  await expect(checkPublishBoundary(role, subject, account)).rejects.toThrow();
  await expect(
    checkPublishBoundary(role, subject + "-other", account),
  ).rejects.toThrow();
  await expect(
    checkPublishBoundary(role + "-other", subject, account),
  ).rejects.toThrow();
  expect(mocked.aws).not.toHaveBeenCalled();
});
