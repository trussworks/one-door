import { z } from "zod";
import { handle, readJson } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";
import { parseInput } from "../../../workflow/shared.ts";
import {
  prepareIntake,
  submitIntake,
} from "../../../workflow/intake-workspace.ts";

const inputSchema = z.object({
  action: z.enum(["prepare", "submit"]),
  input: z.unknown(),
});

export function POST(request: Request) {
  return handle(async () => {
    const visitor = await visitorContext(request);
    const body = parseInput(inputSchema, await readJson(request));
    if (body.action === "prepare") return prepareIntake(visitor, body.input);
    return submitIntake(visitor, body.input);
  });
}
