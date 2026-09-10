import { WorkflowError } from "../workflow/errors.ts";
import { HttpError } from "./auth.ts";

const workflowStatus: Record<string, number> = {
  NOT_FOUND: 404,
  NOT_OWNER: 404,
  INVALID_STATE: 409,
  VERSION_CONFLICT: 409,
  VALIDATION_FAILED: 400,
  CLARIFICATION_PENDING: 409,
  NO_OPEN_CLARIFICATION: 409,
  APPROVAL_BLOCKED: 409,
  RESOLUTION_BLOCKED: 409,
};

export function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function handle(
  action: () => Promise<Response | unknown>,
): Promise<Response> {
  try {
    const result = await action();
    return result instanceof Response ? result : jsonResponse(result);
  } catch (error) {
    if (error instanceof HttpError)
      return jsonResponse({ error: error.code }, error.status);
    if (error instanceof WorkflowError)
      return jsonResponse(
        { error: error.code },
        workflowStatus[error.code] ?? 500,
      );
    console.error("one-door request failed", {
      kind: error instanceof Error ? error.name : "unknown",
    });
    return jsonResponse({ error: "REQUEST_FAILED" }, 500);
  }
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.APP_ORIGIN || request.url);
  // NextRequest normalizes loopback URLs; Host retains the browser's actual
  // authority. Deployments behind a proxy pin their public APP_ORIGIN.
  if (!process.env.APP_ORIGIN)
    expected.host = request.headers.get("host") || expected.host;
  if (!origin || origin !== expected.origin)
    throw new HttpError(403, "ORIGIN_MISMATCH");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new HttpError(415, "JSON_REQUIRED");
}

export async function readJson(request: Request): Promise<unknown> {
  requireSameOrigin(request);
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "BODY_REQUIRED");
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new HttpError(413, "BODY_TOO_LARGE");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new HttpError(400, "JSON_MALFORMED");
  }
}
