import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { modelStatus, retryModel } from "../../../../server/model-access.ts";
import { requireSameOrigin } from "../../../../server/http.ts";
type Context = { params: Promise<{ jobId: string }> };
export function GET(request: Request, context: Context) {
  return handle(async () =>
    modelStatus(await visitorContext(request), (await context.params).jobId),
  );
}
export function POST(request: Request, context: Context) {
  return handle(async () => {
    requireSameOrigin(request);
    return retryModel(
      await visitorContext(request),
      (await context.params).jobId,
    );
  });
}
