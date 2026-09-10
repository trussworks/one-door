import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { workItemView } from "../../../../server/work-item.ts";
export function GET(
  request: Request,
  context: { params: Promise<{ workItemId: string }> },
) {
  return handle(async () => {
    await visitorContext(request);
    return workItemView((await context.params).workItemId);
  });
}
