import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { answerClarification } from "../../../workflow/clarification.ts";

export function POST(request: Request) {
  return handle(async () =>
    answerClarification(await visitorContext(request), await readJson(request)),
  );
}
