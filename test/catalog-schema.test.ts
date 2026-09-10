import { expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import { itemChangesSchema } from "../src/workflow/catalog.ts";

it("preserves optional catalog field types and their existing normalization", () => {
  expectTypeOf<
    z.infer<typeof itemChangesSchema>["ownerOrganizationId"]
  >().toEqualTypeOf<string | undefined>();
  expect(
    itemChangesSchema.parse({
      name: "  Maintained catalog item  ",
      vendor: null,
      capabilities: ["  Hosting  "],
      itemType: "platform",
    }),
  ).toEqual({
    name: "Maintained catalog item",
    vendor: null,
    capabilities: ["Hosting"],
    itemType: "platform",
  });
});

it("still rejects empty changes and invalid individual fields", () => {
  for (const input of [
    {},
    { name: undefined },
    { unrecognized: "value" },
    { itemType: "service" },
    { ownerOrganizationId: 42 },
    { ownerOrganizationId: null },
    { capabilities: "Hosting" },
    { reviewDate: "2026-02-30" },
  ]) {
    expect(itemChangesSchema.safeParse(input).success).toBe(false);
  }
});
