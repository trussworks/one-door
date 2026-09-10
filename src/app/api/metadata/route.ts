import { handle } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { metadata } from "../../../server/metadata.ts";
export function GET(request: Request) {
  return handle(async () => metadata(await visitorContext(request)));
}
