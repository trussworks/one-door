import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { decideService } from "../../../workflow/intake.ts";
export function POST(request: Request) {
  return handle(async () =>
    decideService(await visitorContext(request), await readJson(request)),
  );
}
