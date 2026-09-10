import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  postgres: vi.fn((_url: string, _options: { connect_timeout?: number }) => ({
    mock: true,
  })),
}));
vi.mock("postgres", () => ({ default: calls.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: () => ({ db: true }) }));

const { createDatabase } = await import("../../src/db/client.ts");

it("bounds how long a connection attempt can hold a request", () => {
  createDatabase("postgresql://one_door@example/one_door");
  const [url, options] = calls.postgres.mock.calls[0];
  expect(url).toBe("postgresql://one_door@example/one_door");
  // postgres.js reads no PG* variables and defaults to 30 seconds, so the
  // value has to be passed here rather than set in the task environment.
  expect(options.connect_timeout).toBe(5);
});
