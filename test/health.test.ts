import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
vi.mock("postgres", () => ({
  default: () => Object.assign(mocks.query, { end: mocks.end }),
}));
vi.mock("../src/db/env.ts", () => ({
  serverEnv: () => ({ DATABASE_URL: "postgres://test-only" }),
}));
import { GET } from "../src/app/api/health/route";

afterEach(() => vi.resetAllMocks());
it("reports healthy only after checking the job table and closes the connection", async () => {
  mocks.query.mockResolvedValue([]);
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(mocks.query.mock.calls[0][0].join("")).toContain("FROM model_jobs");
  expect(mocks.end).toHaveBeenCalled();
});
it("reports a database failure without exposing connection details", async () => {
  mocks.query.mockRejectedValue(new Error("private database details"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
  expect(mocks.end).toHaveBeenCalled();
});
