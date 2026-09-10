import { handle } from "../../../server/http.ts";
import { reviewerContext } from "../../../server/visitor.ts";
import { catalogView } from "../../../server/catalog-views.ts";
export function GET(request: Request) {
  return handle(async () => {
    await reviewerContext(request);
    return catalogView();
  });
}
