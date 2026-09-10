import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { answerIntake } from "../../../workflow/intake.ts";
export function POST(request: Request) {
  return handle(async () =>
    answerIntake(await visitorContext(request), await readJson(request)),
  );
}
