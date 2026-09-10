import { handle, readJson } from "../../../server/http.ts";
import { reviewerContext } from "../../../server/visitor.ts";
import { askClarification } from "../../../workflow/clarification.ts";

export function POST(request: Request) {
  return handle(async () =>
    askClarification(await reviewerContext(request), await readJson(request)),
  );
}
