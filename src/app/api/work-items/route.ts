import { handle } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { workItemOptions } from "../../../server/work-item.ts";
export function GET(request: Request) {
  return handle(async () => {
    await visitorContext(request);
    return workItemOptions();
  });
}
