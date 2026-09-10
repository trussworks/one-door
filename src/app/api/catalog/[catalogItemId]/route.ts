import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { getCatalogItemRecord } from "../../../../workflow/catalog.ts";
export function GET(
  request: Request,
  context: { params: Promise<{ catalogItemId: string }> },
) {
  return handle(async () => {
    await visitorContext(request);
    return getCatalogItemRecord((await context.params).catalogItemId);
  });
}
