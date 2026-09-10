import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { requestView } from "../../../../server/request-views.ts";
export function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  return handle(async () => {
    const requesterView =
      new URL(request.url).searchParams.get("view") !== "contributor";
    return requestView(
      await visitorContext(request),
      (await context.params).requestId,
      requesterView,
    );
  });
}
