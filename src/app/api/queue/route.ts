import { handle } from "../../../server/http.ts";
import { reviewerContext } from "../../../server/visitor.ts";
import { queueView } from "../../../server/queue.ts";
import { queueOptions } from "../../../server/query-options.ts";
export function GET(request: Request) {
  return handle(async () => {
    const context = await reviewerContext(request);
    return queueView(
      queueOptions(new URL(request.url).searchParams, context.actorId),
    );
  });
}
