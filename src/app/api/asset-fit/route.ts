import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { decideAssetFit } from "../../../workflow/intake.ts";
export function POST(request: Request) {
  return handle(async () =>
    decideAssetFit(await visitorContext(request), await readJson(request)),
  );
}
