import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { confirmIntake } from "../../../workflow/intake.ts";
export function POST(request: Request) {
  return handle(async () =>
    confirmIntake(await visitorContext(request), await readJson(request)),
  );
}
