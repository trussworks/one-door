import { handle } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { getOwnDraft } from "../../../../workflow/requester.ts";

export function GET(
  request: Request,
  context: { params: Promise<{ draftId: string }> },
) {
  return handle(async () =>
    getOwnDraft(await visitorContext(request), (await context.params).draftId),
  );
}
