import { expect, it } from "vitest";

import {
  acceptableDigests,
  checkService,
  parseImageReference,
  type ServiceState,
  type TaskState,
} from "../../scripts/deploy/verify-release.ts";

const REPOSITORY =
  "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal";
const INDEX = "sha256:" + "a".repeat(64);
const CHILD = "sha256:" + "b".repeat(64);
const OTHER = "sha256:" + "c".repeat(64);
const REVISION =
  "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-web:7";
const PREVIOUS =
  "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-web:6";

const indexManifest = JSON.stringify({
  manifests: [
    { digest: CHILD, platform: { os: "linux", architecture: "amd64" } },
    { digest: OTHER, platform: { os: "unknown", architecture: "unknown" } },
  ],
});

function service(overrides: Partial<ServiceState> = {}): ServiceState {
  return {
    serviceName: "one-door-personal-web",
    status: "ACTIVE",
    desiredCount: 2,
    runningCount: 2,
    deployments: [
      {
        status: "PRIMARY",
        taskDefinition: REVISION,
        rolloutState: "COMPLETED",
      },
    ],
    ...overrides,
  };
}

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskArn: "arn:aws:ecs:us-west-2:845191826742:task/one-door-personal/one",
    lastStatus: "RUNNING",
    desiredStatus: "RUNNING",
    taskDefinitionArn: REVISION,
    healthStatus: "HEALTHY",
    availabilityZone: "us-west-2a",
    containers: [
      {
        name: "web",
        lastStatus: "RUNNING",
        imageDigest: CHILD,
        healthStatus: "HEALTHY",
      },
    ],
    ...overrides,
  };
}

it.each(["UNKNOWN", "UNHEALTHY", undefined])(
  "rejects unconfirmed task or container health: %s",
  (healthStatus) => {
    expect(() =>
      verify({
        tasks: [
          task({ healthStatus }),
          task({ availabilityZone: "us-west-2b" }),
        ],
      }),
    ).toThrow("health must both be HEALTHY");
    expect(() =>
      verify({
        tasks: [
          task({
            containers: [
              {
                name: "web",
                lastStatus: "RUNNING",
                imageDigest: CHILD,
                healthStatus,
              },
            ],
          }),
          task({ availabilityZone: "us-west-2b" }),
        ],
      }),
    ).toThrow("health must both be HEALTHY");
  },
);

function verify(
  overrides: {
    service?: Partial<ServiceState>;
    tasks?: TaskState[];
    digests?: string[];
  } = {},
) {
  return checkService({
    service: service(overrides.service),
    tasks: overrides.tasks ?? [
      task(),
      task({
        availabilityZone: "us-west-2b",
        taskArn:
          "arn:aws:ecs:us-west-2:845191826742:task/one-door-personal/two",
      }),
    ],
    containerName: "web",
    expectedTaskDefinition: REVISION,
    acceptableDigests: overrides.digests ?? [INDEX, CHILD],
    expectedCount: 2,
  });
}

it("requires reported service/container states and a real spread across zones", () => {
  expect(() => verify({ service: { status: undefined } })).toThrow(
    "service status",
  );
  expect(() => verify({ tasks: [task(), task()] })).toThrow(
    "two availability zones",
  );
  expect(() =>
    verify({ tasks: [task(), task({ availabilityZone: undefined })] }),
  ).toThrow("availability zone is unreported");
  expect(() =>
    verify({
      tasks: [
        task(),
        task({ containers: [{ name: "web", imageDigest: CHILD }] }),
      ],
    }),
  ).toThrow("unreported");
});

it("requires a repository digest reference, never a tag", () => {
  expect(parseImageReference(`${REPOSITORY}@${INDEX}`)).toEqual({
    repository: REPOSITORY,
    digest: INDEX,
  });
  for (const bad of [
    `${REPOSITORY}:latest`,
    `${REPOSITORY}@sha256:short`,
    REPOSITORY,
    `${REPOSITORY}@md5:${"a".repeat(64)}`,
  ])
    expect(() => parseImageReference(bad), bad).toThrow("digest reference");
});

it("accepts the promoted index and its linux/amd64 child, and nothing else", () => {
  const digests = acceptableDigests(
    INDEX,
    indexManifest,
    "application/vnd.oci.image.index.v1+json",
  );
  expect(digests).toEqual([INDEX, CHILD]);
  // The attestation manifest carries architecture "unknown" and is excluded.
  expect(digests).not.toContain(OTHER);
});

it("accepts only the digest itself for a single-architecture manifest", () => {
  expect(
    acceptableDigests(
      INDEX,
      JSON.stringify({ config: {}, layers: [] }),
      "application/vnd.oci.image.manifest.v1+json",
    ),
  ).toEqual([INDEX]);
});

it("refuses an index that has no linux/amd64 manifest", () => {
  expect(() =>
    acceptableDigests(
      INDEX,
      JSON.stringify({
        manifests: [
          { digest: OTHER, platform: { os: "linux", architecture: "arm64" } },
        ],
      }),
      "application/vnd.docker.distribution.manifest.list.v2+json",
    ),
  ).toThrow("no linux/amd64");
});

it("confirms a settled release running the promoted image", () => {
  expect(verify()).toEqual({
    serviceName: "one-door-personal-web",
    tasks: 2,
    digests: [CHILD],
  });
});

it("rejects a rolled-back deployment that reached steady state", () => {
  expect(() =>
    verify({
      service: {
        deployments: [
          {
            status: "PRIMARY",
            taskDefinition: PREVIOUS,
            rolloutState: "COMPLETED",
          },
        ],
      },
      tasks: [
        task({ taskDefinitionArn: PREVIOUS }),
        task({ taskDefinitionArn: PREVIOUS }),
      ],
    }),
  ).toThrow(/not the intended/);
});

it("rejects a failed rollout even while a deployment reports completion", () => {
  expect(() =>
    verify({
      service: {
        deployments: [
          {
            status: "PRIMARY",
            taskDefinition: PREVIOUS,
            rolloutState: "COMPLETED",
          },
          {
            status: "ACTIVE",
            taskDefinition: REVISION,
            rolloutState: "FAILED",
            rolloutStateReason: "circuit breaker",
          },
        ],
      },
    }),
  ).toThrow("rolled back");
});

it("rejects an unsettled rollout and a second active deployment", () => {
  expect(() =>
    verify({
      service: {
        deployments: [
          {
            status: "PRIMARY",
            taskDefinition: REVISION,
            rolloutState: "IN_PROGRESS",
          },
        ],
      },
    }),
  ).toThrow("not COMPLETED");
  expect(() =>
    verify({
      service: {
        deployments: [
          {
            status: "PRIMARY",
            taskDefinition: REVISION,
            rolloutState: "COMPLETED",
          },
          {
            status: "ACTIVE",
            taskDefinition: PREVIOUS,
            rolloutState: "COMPLETED",
          },
        ],
      },
    }),
  ).toThrow("has not settled");
});

it("rejects a stopped, draining or missing task", () => {
  expect(() =>
    verify({
      tasks: [
        task(),
        task({
          lastStatus: "STOPPED",
          stoppedReason: "Essential container exited",
        }),
      ],
    }),
  ).toThrow("Essential container exited");
  expect(() =>
    verify({ tasks: [task(), task({ desiredStatus: "STOPPED" })] }),
  ).toThrow(/is RUNNING|STOPPED/);
  expect(() => verify({ tasks: [task()] })).toThrow("1 tasks were described");
});

it("rejects an unreported or foreign image digest", () => {
  expect(() =>
    verify({
      tasks: [
        task(),
        task({ containers: [{ name: "web", lastStatus: "RUNNING" }] }),
      ],
    }),
  ).toThrow("no image digest");
  expect(() =>
    verify({
      tasks: [
        task(),
        task({
          containers: [
            { name: "web", lastStatus: "RUNNING", imageDigest: OTHER },
          ],
        }),
      ],
    }),
  ).toThrow("not the released image");
});

it("rejects counts that do not match the intended release", () => {
  expect(() => verify({ service: { desiredCount: 1 } })).toThrow(
    "desired count is 1",
  );
  expect(() => verify({ service: { runningCount: 1 } })).toThrow(
    "1 of 2 tasks are running",
  );
  expect(() => verify({ service: { status: "DRAINING" } })).toThrow("DRAINING");
});
