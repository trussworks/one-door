import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { submitRequest } from "../../../workflow/requester.ts";

export function POST(request: Request) {
  return handle(async () =>
    submitRequest(await visitorContext(request), await readJson(request)),
  );
}
