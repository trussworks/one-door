import { handle } from "../../../../../server/http.ts";
import { reviewerContext } from "../../../../../server/visitor.ts";
import { getRequestRecord } from "../../../../../workflow/clarification.ts";

export function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  return handle(async () => {
    await reviewerContext(request);
    return getRequestRecord((await context.params).requestId);
  });
}
