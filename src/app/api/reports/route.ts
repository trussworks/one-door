import { handle } from "../../../server/http.ts";
import { reviewerContext } from "../../../server/visitor.ts";
import { reportView } from "../../../server/reports.ts";
import { reportOptions } from "../../../server/query-options.ts";
export function GET(request: Request) {
  return handle(async () =>
    reportView(
      await reviewerContext(request),
      reportOptions(new URL(request.url).searchParams),
    ),
  );
}
