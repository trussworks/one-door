import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { draftView } from "../../../../server/request-views.ts";
export function GET(
  request: Request,
  context: { params: Promise<{ draftId: string }> },
) {
  return handle(async () => {
    const draftId = (await context.params).draftId;
    const visitor = await visitorContext(request);
    return draftView(visitor, draftId);
  });
}
