import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { WorkflowError } from "../../../workflow/errors.ts";
import {
  prepareIntake,
  submitIntake,
} from "../../../workflow/intake-workspace.ts";

export function POST(request: Request) {
  return handle(async () => {
    const visitor = await visitorContext(request);
    const body = (await readJson(request)) as {
      action?: string;
      input?: unknown;
    };
    if (body.action === "prepare") return prepareIntake(visitor, body.input);
    if (body.action === "submit") return submitIntake(visitor, body.input);
    throw new WorkflowError("VALIDATION_FAILED", "unknown workspace action");
  });
}
