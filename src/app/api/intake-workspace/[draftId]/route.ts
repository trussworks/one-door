import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { getIntakeWorkspace } from "../../../../workflow/intake-workspace.ts";

export function GET(
  request: Request,
  context: { params: Promise<{ draftId: string }> },
) {
  return handle(async () => {
    const draftId = (await context.params).draftId;
    const visitor = await visitorContext(request);
    return getIntakeWorkspace(visitor, draftId);
  });
}
