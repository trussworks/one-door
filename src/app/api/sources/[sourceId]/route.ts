import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { getSourceHistory } from "../../../../workflow/inventory.ts";
export function GET(
  request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  return handle(async () => {
    await visitorContext(request);
    return getSourceHistory((await context.params).sourceId);
  });
}
