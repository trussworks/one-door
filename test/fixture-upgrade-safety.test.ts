import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("refuses a normal application database before running fixture-upgrade diagnostics", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "test/fixture-upgrade.integration.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://127.0.0.1:1/one_door_live_mvp",
      },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "require a new isolated one_door_fixup database",
  );
  expect(result.stderr).not.toContain("ECONNREFUSED");
});

function personaScopes(
  seed: ReturnType<typeof import("../src/seed/build.ts").buildSeedData>,
  personaId: string,
) {
  const assignees = new Map<string, string[]>();
  for (const task of seed.reviewTasks) {
    if (!task.requestId || !task.assigneeActorId) continue;
    assignees.set(task.requestId, [
      ...(assignees.get(task.requestId) ?? []),
      task.assigneeActorId,
    ]);
  }
  const coordinators = new Set<string>();
  let mine = 0;
  let unassigned = 0;
  for (const request of seed.requests) {
    const coordinator = request.coordinatingActorId;
    if (coordinator) coordinators.add(coordinator);
    else unassigned++;
    if (
      coordinator === personaId ||
      (assignees.get(request.id) ?? []).includes(personaId)
    )
      mine++;
  }
  return { coordinators, mine, unassigned };
}

it("qualifies every coordinator and keeps the seed and read model agreed", async () => {
  const { demoCoordinatorKey, reviewCoordinatorKeys, seedActors } =
    await import("../src/seed/actors.ts");
  const { demoReviewPersonaKey } = await import("../src/server/metadata.ts");
  // Varying the coordinator silently empties "My assignments" if the seed and
  // the read model stop naming the same demo reviewer.
  expect(demoReviewPersonaKey).toBe("actor:" + demoCoordinatorKey);
  expect(reviewCoordinatorKeys).toContain(demoCoordinatorKey);
  for (const key of reviewCoordinatorKeys)
    expect(
      seedActors.find((actor) => actor.key === key)?.capabilities,
      key,
    ).toContain("coordinate_first_review");
});

it("spreads seeded coordinators without emptying the demo reviewer's queue", async () => {
  const { buildSeedData } = await import("../src/seed/build.ts");
  const { demoCoordinatorKey, reviewCoordinatorKeyFor } =
    await import("../src/seed/actors.ts");
  const seed = buildSeedData();
  const persona = seed.actors.find(
    (actor) => actor.fixtureKey === "actor:" + demoCoordinatorKey,
  );
  expect(persona).toBeDefined();
  const scopes = personaScopes(seed, persona!.id);
  expect(
    scopes.coordinators.size,
    "more than one person coordinates",
  ).toBeGreaterThan(1);
  expect(scopes.coordinators.has(persona!.id)).toBe(true);
  expect(
    scopes.mine,
    "the demo reviewer keeps a populated queue",
  ).toBeGreaterThan(9);
  expect(scopes.unassigned, "genuine unclaimed rows remain").toBeGreaterThan(0);
  // The choice depends only on the request key, so a rebuild is identical.
  expect(reviewCoordinatorKeyFor("example-request")).toBe(
    reviewCoordinatorKeyFor("example-request"),
  );
});
