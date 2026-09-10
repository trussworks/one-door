import { handle } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { inventoryOverview } from "../../../server/catalog-views.ts";
export function GET(request: Request) {
  return handle(async () => {
    await visitorContext(request);
    return inventoryOverview();
  });
}
