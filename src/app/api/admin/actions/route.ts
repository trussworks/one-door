import { z } from "zod";
import { handle, readJson } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { parseInput } from "../../../../workflow/shared.ts";
import {
  addCatalogItem,
  reviseCatalogItem,
  publishCatalogItem,
  retireCatalogItem,
  confirmCatalogItemAccurate,
} from "../../../../workflow/catalog.ts";
import {
  registerSource,
  updateSource,
  retireSource,
  resolveConflict,
} from "../../../../workflow/inventory.ts";
import {
  addAdministratorNote,
  importFixture,
  resetFixtures,
} from "../../../../workflow/admin.ts";
import { updateWorkItemStatus } from "../../../../workflow/delivery.ts";

const actions = {
  addAdministratorNote,
  addCatalogItem,
  reviseCatalogItem,
  publishCatalogItem,
  retireCatalogItem,
  confirmCatalogItemAccurate,
  registerSource,
  updateSource,
  retireSource,
  resolveConflict,
  importFixture,
  resetFixtures,
  updateWorkItemStatus,
};
const schema = z.object({
  action: z.enum(
    Object.keys(actions) as [keyof typeof actions, ...(keyof typeof actions)[]],
  ),
  input: z.unknown(),
});
export function POST(request: Request) {
  return handle(async () => {
    const context = {
      ...(await visitorContext(request)),
      actingView: "administrator" as const,
    };
    const data = parseInput(schema, await readJson(request));
    if (data.action === "resetFixtures")
      parseInput(z.object({ confirmed: z.literal(true) }), data.input);
    return actions[data.action](context, data.input);
  });
}
