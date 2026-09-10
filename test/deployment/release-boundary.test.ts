import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ aws: vi.fn() }));
vi.mock("../../scripts/deploy/aws.ts", async (original) => ({
  ...(await original<typeof import("../../scripts/deploy/aws.ts")>()),
  aws: mocked.aws,
}));
import { AwsError } from "../../scripts/deploy/aws.ts";
import { checkReleaseBoundary } from "../../scripts/deploy/check-release-boundary.ts";

const p = {
  account_id: "004351505091",
  region: "us-west-2",
  name: "one-door-truss",
  secret_arns: {
    runtime:
      "arn:aws:secretsmanager:us-west-2:004351505091:secret:one-door-truss/runtime-example",
  },
};
const identity = {
  Account: p.account_id,
  Arn: `arn:aws:sts::${p.account_id}:assumed-role/${p.name}-release/check`,
};
afterEach(() => vi.resetAllMocks());

it.each(["AccessDenied", "AccessDeniedException"])(
  "requires %s for all three protected states and the secret",
  (denialCode) => {
    mocked.aws.mockReturnValueOnce(identity).mockImplementation(() => {
      throw new AwsError(denialCode, "read");
    });
    expect(checkReleaseBoundary(p).denied).toEqual([
      "bootstrap state",
      "platform state",
      "install state",
      "runtime secret",
    ]);
    expect(mocked.aws.mock.calls.slice(1, 4).map(([args]) => args)).toEqual(
      ["bootstrap", "platform", "install"].map((stack) => [
        "s3api",
        "get-object",
        "--bucket",
        "one-door-state-004351505091-us-west-2",
        "--key",
        `${stack}/terraform.tfstate`,
        "--range",
        "bytes=0-0",
        "/dev/null",
        "--region",
        "us-west-2",
      ]),
    );
    expect(mocked.aws.mock.calls[4][0]).toContain(p.secret_arns.runtime);
  },
);

it.each(["NoSuchKey", "ResourceNotFoundException", "COMMAND_FAILED"])(
  "refuses %s as proof of an access boundary",
  (code) => {
    mocked.aws.mockReturnValueOnce(identity).mockImplementation(() => {
      throw new AwsError(code, "read");
    });
    expect(() => checkReleaseBoundary(p)).toThrow(code);
  },
);

it("refuses successful access without including its response in the error", () => {
  mocked.aws
    .mockReturnValueOnce(identity)
    .mockReturnValue({ private: "value" });
  expect(() => checkReleaseBoundary(p)).toThrow(
    "Deployment role unexpectedly read bootstrap state",
  );
});

it("does not credit denials from another role", () => {
  mocked.aws.mockReturnValue({
    ...identity,
    Arn: identity.Arn.replace("-release/", "-publish/"),
  });
  expect(() => checkReleaseBoundary(p)).toThrow("deployment role");
  expect(mocked.aws).toHaveBeenCalledTimes(1);
});

it("refuses a different account before attempting any protected read", () => {
  mocked.aws.mockReturnValue({ ...identity, Account: "845191826742" });
  expect(() => checkReleaseBoundary(p)).toThrow();
  expect(mocked.aws).toHaveBeenCalledTimes(1);
});
