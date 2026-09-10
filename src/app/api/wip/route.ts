import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { loadWip, saveWip } from "../../../workflow/wip.ts";

export function GET(request: Request) {
  return handle(async () =>
    loadWip(
      await visitorContext(request),
      Object.fromEntries(new URL(request.url).searchParams),
    ),
  );
}
export function POST(request: Request) {
  return handle(async () =>
    saveWip(await visitorContext(request), await readJson(request)),
  );
}
