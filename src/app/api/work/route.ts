import { handle } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { myWork } from "../../../server/my-work.ts";

export function GET(request: Request) {
  return handle(async () => myWork(await visitorContext(request)));
}
