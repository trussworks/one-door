import { handle, readJson } from "../../../../server/http.ts";
import { visitorContext } from "../../../../server/visitor.ts";
import { answerReviewInput } from "../../../../workflow/review-inputs.ts";

export function POST(request: Request) {
  return handle(async () => {
    const visitor = await visitorContext(request);
    return answerReviewInput(
      { visitorId: visitor.visitorId, actingView: "requester" },
      await readJson(request),
    );
  });
}
