import { z } from "zod";
import { handle, readJson } from "../../../../server/http.ts";
import { reviewerContext } from "../../../../server/visitor.ts";
import { parseInput } from "../../../../workflow/shared.ts";
import {
  saveAssetDecision,
  recordAssetOutcome,
  recordRiskOutcome,
  saveRiskDecision,
  saveRiceScore,
  assignReview,
  recordRouting,
  addReviewCandidate,
} from "../../../../workflow/review.ts";
import { submitAssessment } from "../../../../workflow/review-submission.ts";
import { savePriority } from "../../../../workflow/priority.ts";
import {
  askReviewInput,
  assignReviewInput,
  answerReviewInput,
} from "../../../../workflow/review-inputs.ts";
import {
  completeFirstReview,
  executeHandoff,
  updateWorkItemStatus,
  linkWorkItem,
  resolveRequest,
} from "../../../../workflow/delivery.ts";

const actions = {
  saveAssetDecision,
  recordAssetOutcome,
  recordRiskOutcome,
  saveRiskDecision,
  saveRiceScore,
  assignReview,
  recordRouting,
  completeFirstReview,
  executeHandoff,
  updateWorkItemStatus,
  linkWorkItem,
  resolveRequest,
  submitAssessment,
  savePriority,
  addReviewCandidate,
  askReviewInput,
  assignReviewInput,
  answerReviewInput,
};
const inputSchema = z.object({
  action: z.enum(
    Object.keys(actions) as [keyof typeof actions, ...(keyof typeof actions)[]],
  ),
  input: z.unknown(),
});
export function POST(request: Request) {
  return handle(async () => {
    const context = await reviewerContext(request);
    const data = parseInput(inputSchema, await readJson(request));
    const actingView =
      data.action === "assignReviewInput"
        ? "administrator"
        : context.actingView;
    return actions[data.action]({ ...context, actingView }, data.input);
  });
}
