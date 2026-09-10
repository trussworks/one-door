import { z } from "zod";
import { getOwnDraft } from "../workflow/requester.ts";
import { getRequestRecord } from "../workflow/clarification.ts";
import { getDeliveryState } from "../workflow/delivery.ts";
import { WorkflowError } from "../workflow/errors.ts";
import { parseInput, type VisitorContext } from "../workflow/shared.ts";
import { enqueueModelJob, getModelJob, retryModelJob } from "../models/jobs.ts";

const inputSchema = z.object({
  purpose: z.enum(["intake_interpret", "asset_match", "risk_assess"]),
  draftId: z.uuid(),
  requestId: z.uuid().optional(),
});

async function allowModelWork(
  context: VisitorContext,
  draftId: string,
  requestId?: string | null,
) {
  if (!requestId) {
    const draft = await getOwnDraft(context, draftId);
    if (draft.state === "submitted")
      throw new WorkflowError(
        "INVALID_STATE",
        "requestId required after submission",
      );
    return;
  }
  const [record, delivery] = await Promise.all([
    getRequestRecord(requestId),
    getDeliveryState(requestId),
  ]);
  if (delivery.resolution || record.stage === "first_review_completed")
    throw new WorkflowError("INVALID_STATE", "review is closed");
}

export async function queueModel(context: VisitorContext, input: unknown) {
  const data = parseInput(inputSchema, input);
  await allowModelWork(context, data.draftId, data.requestId);
  return enqueueModelJob(context, data);
}

export async function modelStatus(context: VisitorContext, jobId: string) {
  const job = await getModelJob(jobId);
  if (!job.requestId) await getOwnDraft(context, job.draftId);
  else await getRequestRecord(job.requestId);
  return {
    jobId: job.jobId,
    draftId: job.draftId,
    requestId: job.requestId,
    purpose: job.purpose,
    status: job.status,
    sanitizedError: job.sanitizedError,
    currentCall: job.currentCall,
  };
}

export async function retryModel(context: VisitorContext, jobId: string) {
  const job = await getModelJob(jobId);
  await allowModelWork(context, job.draftId, job.requestId);
  return retryModelJob(context, { jobId });
}
