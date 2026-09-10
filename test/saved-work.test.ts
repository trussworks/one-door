import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { SavedWorkStatus } from "../src/ui/saved-work-controller";
import {
  changeSavedWork,
  createController,
  loadSaved,
  queueSave,
  refreshUnchangedTokens,
  type Controller,
  type Saved,
} from "../src/ui/saved-work-controller";

const transport = vi.hoisted(() => ({
  server: null as Saved | null,
  fail: false,
  wait: null as Promise<void> | null,
}));
vi.mock("../src/ui/api", async (original) => {
  const actual = await original<typeof import("../src/ui/api")>();
  return {
    ...actual,
    api: async (
      _path: string,
      body?: {
        payload: Record<string, string>;
        expectedRowVersion: number;
      },
    ) => {
      if (!body) return structuredClone(transport.server);
      await transport.wait;
      if (transport.fail) throw new Error("offline");
      if (body.expectedRowVersion !== (transport.server?.rowVersion ?? 0))
        throw new actual.ApiError("VERSION_CONFLICT", 409);
      transport.server = {
        payload: { ...body.payload },
        rowVersion: body.expectedRowVersion + 1,
      };
      return structuredClone(transport.server);
    },
  };
});

const key = JSON.stringify({
  visitorId: "test-visitor",
  actingView: "requester",
  pageKey: "start-request",
  subjectKey: "test-draft",
});
const storage = new Map<string, string>();
const initial = { text: "" };
type Model = {
  text: string;
  remote: string;
  dirty: boolean;
  conflict: boolean;
};
type Real = { controller: Controller; status: SavedWorkStatus | null };

async function fresh(): Promise<{ model: Model; real: Real }> {
  transport.server = null;
  transport.fail = false;
  transport.wait = null;
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => storage.set(name, value),
  });
  const real: Real = { controller: createController(initial), status: null };
  await reopen(real);
  return {
    model: { text: "", remote: "", dirty: false, conflict: false },
    real,
  };
}

async function reopen(real: Real) {
  real.controller.mounted = false;
  real.controller = createController(initial);
  await loadSaved(real.controller, key, initial, real.controller.loadId);
}

function edit(real: Real, value: string) {
  changeSavedWork(real.controller, key, {
    name: "text",
    value,
    route: "/new?draft=test-draft",
  });
}

function flush(real: Real) {
  return queueSave(real.controller, key, (status) => {
    real.status = status;
  });
}

function assertState(model: Model, real: Real) {
  expect(real.controller.values.text).toBe(model.text);
  expect(transport.server?.payload.text ?? "").toBe(model.remote);
  expect(real.controller.sequence !== real.controller.savedSequence).toBe(
    model.dirty,
  );
  const backup = JSON.parse(storage.get(key) ?? "null");
  expect(backup?.unsent ?? false).toBe(model.dirty);
}

function command(
  name: string,
  action: (model: Model, real: Real) => void | Promise<void>,
): fc.AsyncCommand<Model, Real> {
  return {
    check: () => true,
    run: async (model, real) => {
      await action(model, real);
      assertState(model, real);
    },
    toString: () => name,
  };
}

const editCommand = fc.string({ maxLength: 80 }).map((text) =>
  command("edit(" + JSON.stringify(text) + ")", (model, real) => {
    edit(real, text);
    model.text = text;
    model.dirty = true;
  }),
);
const remoteCommand = fc.string({ maxLength: 80 }).map((text) =>
  command("another-tab-saves(" + JSON.stringify(text) + ")", (model) => {
    transport.server = {
      payload: { text },
      rowVersion: (transport.server?.rowVersion ?? 0) + 1,
    };
    model.remote = text;
    model.conflict = true;
  }),
);
const reloadCommand = fc.constant(
  command("reopen", async (model, real) => {
    await reopen(real);
    if (!model.dirty) {
      model.text = model.remote;
      model.conflict = false;
    }
  }),
);
const saveCommand = fc.boolean().map((offline) =>
  command(offline ? "save-offline" : "save", async (model, real) => {
    transport.fail = offline;
    if (model.dirty && (offline || model.conflict)) {
      await expect(flush(real)).rejects.toThrow();
      expect(
        real.status?.kind === "failed" || real.status?.kind === "conflict",
      ).toBe(true);
      expect([
        "A newer draft is already saved on the server. These changes were not saved over it.",
        "Draft save could not be confirmed. Your entries remain in this open form. Retry saving before leaving.",
      ]).toContain(real.status?.message);
    } else {
      await flush(real);
      model.remote = model.dirty ? model.text : model.remote;
      model.dirty = false;
    }
    transport.fail = false;
  }),
);

afterEach(() => vi.unstubAllGlobals());

it("preserves local edits and confirmed remote values across generated save/reopen/conflict sequences", async () => {
  await expect(
    fc.assert(
      fc.asyncProperty(
        fc.commands([editCommand, remoteCommand, reloadCommand, saveCommand], {
          maxCommands: 40,
        }),
        async (commands) => {
          const state = await fresh();
          await fc.asyncModelRun(() => state, commands);
        },
      ),
      { seed: 20260906, numRuns: 200 },
    ),
  ).resolves.toBeUndefined();
});

it("does not mark an edit made during a pending write as saved", async () => {
  const { real } = await fresh();
  edit(real, "first");
  let release!: () => void;
  transport.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = flush(real);
  await vi.waitFor(() => expect(real.status?.kind).toBe("saving"));
  expect(real.status?.message).toBe("Saving your draft…");
  edit(real, "second");
  const next = flush(real);
  expect(transport.server).toBeNull();
  release();
  await saving;
  await next;
  expect(transport.server?.payload.text).toBe("second");
  expect(transport.server?.rowVersion).toBe(2);
  expect(real.status?.kind).toBe("saved");
  expect(real.status?.message).toBe("Your draft is saved.");
  expect(real.controller.savedSequence).toBe(real.controller.sequence);
});

it("requires explicit recovery before an unsent reopened draft replaces a newer tab's save", async () => {
  const { real } = await fresh();
  edit(real, "my unsent change");
  transport.server = {
    payload: { text: "newer other-tab change" },
    rowVersion: 1,
  };
  await reopen(real);
  await expect(flush(real)).rejects.toThrow("VERSION_CONFLICT");
  expect(real.controller.values.text).toBe("my unsent change");
  expect(transport.server.payload.text).toBe("newer other-tab change");
});

it("keeps a confirmed save current when a record token refreshes during its request", async () => {
  const { real } = await fresh();
  edit(real, "unchanged submitted text");
  changeSavedWork(real.controller, key, {
    name: "_recordVersion",
    value: "1",
    route: "/review/test",
  });
  let release!: () => void;
  transport.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = flush(real);
  await vi.waitFor(() => expect(real.status?.kind).toBe("saving"));
  expect(
    refreshUnchangedTokens(
      real.controller,
      { text: "unchanged submitted text", _recordVersion: "2" },
      key,
    ),
  ).toBe(true);
  release();
  await saving;
  expect(transport.server?.rowVersion).toBe(1);
  expect(real.controller.rowVersion).toBe(1);
  expect(JSON.parse(storage.get(key)!)).toEqual({
    values: { text: "unchanged submitted text", _recordVersion: "2" },
    unsent: false,
    rowVersion: 1,
  });
  await reopen(real);
  edit(real, "next reviewer action");
  await expect(flush(real)).resolves.toBeUndefined();
  expect(transport.server?.payload.text).toBe("next reviewer action");
  expect(transport.server?.rowVersion).toBe(2);
});

it("does not let an unmounted panel's pending save erase a reopened panel's local edits", async () => {
  const { real } = await fresh();
  edit(real, "first panel's text");
  let release!: () => void;
  transport.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = flush(real);
  await vi.waitFor(() => expect(real.status?.kind).toBe("saving"));
  expect(real.status?.message).toBe("Saving your draft…");
  const previousController = real.controller;
  await reopen(real);
  edit(real, "newer reopened edit");
  expect(
    refreshUnchangedTokens(
      previousController,
      { text: "first panel's text", _recordVersion: "2" },
      key,
    ),
  ).toBe(true);
  release();
  await saving;
  expect(transport.server?.payload.text).toBe("first panel's text");
  expect(JSON.parse(storage.get(key)!).values.text).toBe("newer reopened edit");
  await reopen(real);
  expect(real.controller.values.text).toBe("newer reopened edit");
});

it("does not rebase a newer panel's backup when only its text happens to match", async () => {
  const { real } = await fresh();
  edit(real, "shared text");
  changeSavedWork(real.controller, key, {
    name: "_recordVersion",
    value: "1",
    route: "/review/test",
  });
  const newerBackup = {
    values: { text: "shared text", _recordVersion: "1" },
    unsent: false,
    rowVersion: 1,
  };
  storage.set(key, JSON.stringify(newerBackup));
  transport.server = { payload: newerBackup.values, rowVersion: 1 };
  expect(
    refreshUnchangedTokens(
      real.controller,
      { text: "shared text", _recordVersion: "2" },
      key,
    ),
  ).toBe(true);
  expect(JSON.parse(storage.get(key)!)).toEqual(newerBackup);
  await expect(flush(real)).rejects.toThrow("VERSION_CONFLICT");
  expect(transport.server.rowVersion).toBe(1);
});

it.each([
  '"old-format"',
  '{"values":null,"unsent":true}',
  '{"values":{"text":42},"unsent":true}',
  '{"values":{"text":"bad version"},"unsent":true,"rowVersion":-1}',
])(
  "ignores unusable browser backup %s and restores the server draft",
  async (backup) => {
    const { real } = await fresh();
    transport.server = {
      payload: { text: "saved server draft" },
      rowVersion: 2,
    };
    storage.set(key, backup);
    await reopen(real);
    expect(real.controller.values.text).toBe("saved server draft");
    expect(real.controller.rowVersion).toBe(2);
  },
);
