import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { queueModel } from "../../../server/model-access.ts";
export function POST(request: Request) {
  return handle(async () =>
    queueModel(await visitorContext(request), await readJson(request)),
  );
}
