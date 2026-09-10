import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { getOwnRequest } from "../../../../workflow/requester.ts";

export function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  return handle(async () =>
    getOwnRequest(
      await visitorContext(request),
      (await context.params).requestId,
    ),
  );
}
