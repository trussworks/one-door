import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/ui/api", () => ({ api: mocks.api }));

import {
  readUntilCurrent,
  type ReadController,
  type ReadResult,
} from "../src/ui/use-data";

function controller(): ReadController {
  return {
    mounted: true,
    requested: 1,
    handled: 0,
    pending: null,
    abort: null,
  };
}

/** Collects what the loop publishes, applying updater functions as React does. */
function recorder<T>(initial: ReadResult<T> = { path: null }) {
  const published: ReadResult<T>[] = [];
  let current = initial;
  const setResult = (next: React.SetStateAction<ReadResult<T>>) => {
    current = typeof next === "function" ? next(current) : next;
    published.push(current);
  };
  return { published, setResult, latest: () => current };
}

beforeEach(() => vi.clearAllMocks());

it("answers a refresh asked for while the read was in flight", async () => {
  const read = controller();
  const { published, setResult } = recorder<string>();
  mocks.api
    .mockImplementationOnce(async () => {
      read.requested += 1;
      return "first";
    })
    .mockResolvedValueOnce("second");

  await readUntilCurrent(read, "/api/queue", setResult, false);

  expect(mocks.api).toHaveBeenCalledTimes(2);
  expect(published.at(-1)).toEqual({
    path: "/api/queue",
    data: "second",
    loading: false,
  });
  expect(read.handled).toBe(read.requested);
});

it("coalesces refreshes asked for before the loop starts", async () => {
  const read = controller();
  read.requested = 3;
  const { setResult } = recorder<string>();
  mocks.api.mockResolvedValue("only");

  await readUntilCurrent(read, "/api/queue", setResult, false);

  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(read.handled).toBe(3);
});

it("publishes nothing after the caller unmounts", async () => {
  const read = controller();
  const { published, setResult } = recorder<string>();
  mocks.api.mockImplementation(async () => {
    read.mounted = false;
    return "late";
  });

  await readUntilCurrent(read, "/api/queue", setResult, false);

  expect(published).toHaveLength(1);
  expect(published[0].loading).toBe(true);
});

it("publishes nothing for an aborted read and does not loop again", async () => {
  const read = controller();
  const { published, setResult } = recorder<string>();
  mocks.api.mockImplementation(async () => {
    read.abort?.abort();
    return "superseded";
  });

  await readUntilCurrent(read, "/api/queue", setResult, false);

  expect(published).toHaveLength(1);
  expect(published[0].loading).toBe(true);
  expect(read.handled).toBe(1);
});

it("publishes a failure and keeps the data the retention rule allows", async () => {
  const read = controller();
  const { setResult, latest } = recorder<string>({
    path: "/api/queue?page=1",
    data: "kept",
  });
  mocks.api.mockRejectedValue(new Error("offline"));

  await readUntilCurrent(read, "/api/queue?page=2", setResult, true);

  expect(latest()).toEqual({
    path: "/api/queue?page=2",
    data: "kept",
    error: expect.any(Error),
    loading: false,
  });
});

it("drops data from another resource when a failure publishes", async () => {
  const read = controller();
  const { setResult, latest } = recorder<string>({
    path: "/api/catalog",
    data: "other resource",
  });
  mocks.api.mockRejectedValue(new Error("offline"));

  await readUntilCurrent(read, "/api/queue", setResult, true);

  expect(latest().data).toBeUndefined();
  expect(latest().error).toBeInstanceOf(Error);
});

it("answers a refresh that arrives while a failed read is still pending", async () => {
  const read = controller();
  const { published, setResult } = recorder<string>();
  mocks.api
    .mockImplementationOnce(async () => {
      read.requested += 1;
      throw new Error("offline");
    })
    .mockResolvedValueOnce("recovered");

  await readUntilCurrent(read, "/api/queue", setResult, false);

  expect(mocks.api).toHaveBeenCalledTimes(2);
  expect(published.at(-1)).toEqual({
    path: "/api/queue",
    data: "recovered",
    loading: false,
  });
  expect(published.at(-1)?.error).toBeUndefined();
  expect(read.handled).toBe(read.requested);
});

it("answers a refresh that arrives while an aborted read is still pending", async () => {
  const read = controller();
  const { published, setResult } = recorder<string>();
  mocks.api
    .mockImplementationOnce(async () => {
      read.abort?.abort();
      read.requested += 1;
      return "superseded";
    })
    .mockResolvedValueOnce("current");

  await readUntilCurrent(read, "/api/queue", setResult, false);

  expect(mocks.api).toHaveBeenCalledTimes(2);
  // The aborted attempt published nothing, so only its loading notice and the
  // later read's loading notice and result reach the caller.
  expect(published.map((entry) => entry.data)).toEqual([
    undefined,
    undefined,
    "current",
  ]);
  expect(read.handled).toBe(read.requested);
});
