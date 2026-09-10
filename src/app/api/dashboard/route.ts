import { handle } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { dashboardView } from "../../../server/dashboard.ts";
export function GET(request: Request) {
  return handle(async () => {
    await visitorContext(request);
    const search = new URL(request.url).searchParams;
    const thresholds = {
      internalBusinessDays: Number(search.get("internal") || 3),
      requesterBusinessDays: Number(search.get("requester") || 5),
    };
    return dashboardView({ thresholds });
  });
}
