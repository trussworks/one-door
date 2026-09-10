import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { saveDraft } from "../../../workflow/requester.ts";

export function POST(request: Request) {
  return handle(async () =>
    saveDraft(await visitorContext(request), await readJson(request)),
  );
}
