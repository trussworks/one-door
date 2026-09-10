import { handle } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { withReadSnapshot } from "../../../workflow/shared.ts";
import { requests } from "../../../db/schema.ts";
export function GET(request: Request) {
  return handle(async () => {
    await visitorContext(request);
    return withReadSnapshot((db) =>
      db
        .select({
          requestId: requests.id,
          displayId: requests.displayId,
          title: requests.title,
        })
        .from(requests),
    );
  });
}
