import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { sourceObservation } from "../../../../server/catalog-views.ts";
export function GET(
  request: Request,
  context: { params: Promise<{ recordId: string }> },
) {
  return handle(async () => {
    await visitorContext(request);
    return sourceObservation((await context.params).recordId);
  });
}
