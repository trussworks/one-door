import { inspect } from "node:util";
import { expect, it } from "vitest";
import { anthropicProvider, defaultModel } from "../src/models/provider.ts";

it.each([
  ["TimeoutError", "provider_timeout"],
  ["AbortError", "provider_timeout"],
  ["TypeError", "provider_network_error"],
])("redacts %s without retaining its message or cause", async (name, code) => {
  const raw = "private request detail from the transport";
  const original = Object.assign(new Error(raw, { cause: new Error(raw) }), {
    name,
    context: raw,
  });
  const provider = anthropicProvider(async () => {
    throw original;
  });
  let observed: unknown;
  try {
    await provider.complete({
      model: defaultModel,
      system: "test",
      input: "test",
      maxOutputTokens: 16,
      outputSchema: { type: "object" },
    });
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(Error);
  expect((observed as Error).message).toBe(code);
  expect((observed as Error).cause).toBeUndefined();
  expect(inspect(observed, { depth: null })).not.toContain(raw);
});
