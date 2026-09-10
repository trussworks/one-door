import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { getConflictComparison } from "../../../../workflow/inventory.ts";
export function GET(
  request: Request,
  context: { params: Promise<{ conflictId: string }> },
) {
  return handle(async () => {
    await visitorContext(request);
    return getConflictComparison((await context.params).conflictId);
  });
}
