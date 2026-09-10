import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ aws: vi.fn(), progress: vi.fn() }));
vi.mock("../../scripts/deploy/aws.ts", async (original) => ({
  ...(await original<typeof import("../../scripts/deploy/aws.ts")>()),
  aws: mocked.aws,
}));
vi.mock("../../scripts/deploy/worker-progress.ts", () => ({
  waitForWorkerProgress: mocked.progress,
}));
import {
  verifyServices,
  type TaskState,
} from "../../scripts/deploy/verify-release.ts";
import type { Platform } from "../../scripts/deploy/aws.ts";

const p = {
  name: "one-door-personal",
  region: "us-west-2",
  cluster_arn: "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal",
} as Platform;
const digest = "sha256:" + "a".repeat(64);
const definitions = Object.fromEntries(
  ["web", "worker"].map((name) => [
    name,
    `arn:aws:ecs:us-west-2:845191826742:task-definition/${p.name}-${name}:10`,
  ]),
);
const target = {
  image:
    "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@" + digest,
  digests: [digest],
  definitions,
  counts: { web: 2, worker: 2 },
};
afterEach(() => vi.resetAllMocks());

function fixtures() {
  const current = Object.fromEntries(
    ["web", "worker"].map((name) => [
      name,
      [0, 1].map((index) => ({
        taskArn: `arn:aws:ecs:us-west-2:845191826742:task/${p.name}/${name}-${index}`,
        desiredStatus: "RUNNING",
        lastStatus: "RUNNING",
        taskDefinitionArn: definitions[name],
        healthStatus: "HEALTHY",
        availabilityZone: "us-west-2" + (index ? "b" : "a"),
        containers: [
          {
            name,
            lastStatus: "RUNNING",
            imageDigest: digest,
            healthStatus: "HEALTHY",
          },
        ],
      })),
    ]),
  ) as Record<string, TaskState[]>;
  mocked.aws.mockImplementation((args: string[]) => {
    if (args[1] === "list-tasks") {
      const name = args[args.indexOf("--service-name") + 1].endsWith("-web")
        ? "web"
        : "worker";
      return { taskArns: current[name].map((task) => task.taskArn) };
    }
    if (args[1] === "describe-tasks")
      return {
        tasks: Object.values(current)
          .flat()
          .filter((task) => args.includes(task.taskArn)),
      };
    const serviceName = args[args.indexOf("--services") + 1];
    const name = serviceName.endsWith("-web") ? "web" : "worker";
    return {
      services: [
        {
          serviceName,
          status: "ACTIVE",
          desiredCount: 2,
          runningCount: 2,
          deployments: [
            {
              status: "PRIMARY",
              taskDefinition: definitions[name],
              rolloutState: "COMPLETED",
            },
          ],
        },
      ],
    };
  });
  mocked.progress.mockResolvedValue([]);
  return current;
}

it("rechecks web task identity after waiting for worker evidence", async () => {
  const current = fixtures();
  mocked.progress.mockImplementation(async () => {
    current.web[0] = {
      ...current.web[0],
      taskArn: current.web[0].taskArn + "-replacement",
    };
    return [];
  });
  await expect(verifyServices(p, target)).rejects.toThrow(
    "Tasks changed after evidence collection",
  );
});

it("rechecks web health after worker evidence and accepts only stable snapshots", async () => {
  const current = fixtures();
  mocked.progress.mockImplementation(async () => {
    current.web[0].healthStatus = "UNKNOWN";
    return [];
  });
  await expect(verifyServices(p, target)).rejects.toThrow(
    "health must both be HEALTHY",
  );
  fixtures();
  expect(await verifyServices(p, target)).toHaveLength(2);
});
