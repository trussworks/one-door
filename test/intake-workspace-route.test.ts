import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/intake-workspace/route.ts";
import { HttpError } from "../src/server/auth.ts";

const mocks = vi.hoisted(() => ({
  visitorContext: vi.fn(),
  prepareIntake: vi.fn(),
  submitIntake: vi.fn(),
}));
vi.mock("../src/server/visitor.ts", () => ({
  visitorContext: mocks.visitorContext,
}));
vi.mock("../src/workflow/intake-workspace.ts", () => ({
  prepareIntake: mocks.prepareIntake,
  submitIntake: mocks.submitIntake,
}));

const visitor = { visitorId: "visitor", actorId: "actor" };
function request(body: unknown) {
  return new Request("http://localhost/api/intake-workspace", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.visitorContext.mockResolvedValue(visitor);
});

it.each([null, {}, { action: "unknown", input: {} }])(
  "rejects an invalid envelope without dispatching: %j",
  async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "VALIDATION_FAILED" });
    expect(mocks.prepareIntake).not.toHaveBeenCalled();
    expect(mocks.submitIntake).not.toHaveBeenCalled();
  },
);

it.each(["prepare", "submit"] as const)(
  "dispatches %s with the authenticated visitor and unchanged input",
  async (action) => {
    const input = { draftId: "draft", answer: "a supplied answer" };
    const operation =
      action === "prepare" ? mocks.prepareIntake : mocks.submitIntake;
    operation.mockResolvedValue({ result: action });
    const response = await POST(request({ action, input, extra: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: action });
    expect(operation).toHaveBeenCalledExactlyOnceWith(visitor, input);
    expect(
      action === "prepare" ? mocks.submitIntake : mocks.prepareIntake,
    ).not.toHaveBeenCalled();
  },
);

it("authenticates before validating the envelope", async () => {
  mocks.visitorContext.mockRejectedValue(
    new HttpError(401, "SIGN_IN_REQUIRED"),
  );
  const response = await POST(request(null));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "SIGN_IN_REQUIRED" });
  expect(mocks.prepareIntake).not.toHaveBeenCalled();
  expect(mocks.submitIntake).not.toHaveBeenCalled();
});
