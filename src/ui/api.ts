const REQUEST_TIMEOUT_MS = 30000;

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined")
      window.dispatchEvent(new Event("one-door-session-expired"));
    throw new ApiError(result.error ?? "REQUEST_FAILED", response.status);
  }
  return result as T;
}

const errors: Record<string, string> = {
  DEMO_ACCESS_REQUIRED:
    "Enter the current demo code to continue. Your stored work has not been deleted.",
  DEMO_NOT_CONFIGURED:
    "Demo access is not configured. An operator needs to set it up.",
  ACCESS_CODE_NOT_RECOGNIZED:
    "The code was not accepted. Check it and try again.",
  GATE_RATE_LIMITED:
    "Too many access attempts. Wait 15 minutes before trying again.",
  VERSION_CONFLICT:
    "A newer version is available. Reload and review it before keeping your entries.",
  VALIDATION_FAILED:
    "Check your entries for missing required information or unsupported values and formats, then try again.",
  NOT_FOUND:
    "The requested item is missing or unavailable. Check the link or selection and try again; ask an operator for help if the problem continues.",
  NOT_OWNER: "This request belongs to a different visitor.",
  APPROVAL_BLOCKED:
    "Review cannot be completed yet. Check the outstanding work listed.",
  RESOLUTION_BLOCKED:
    "Fulfillment cannot be recorded yet. Check required work and whether its source information is current.",
  INVALID_STATE:
    "This action is not available with the current details or status. Check the requirements and any conflicting entries before trying again.",
  CLARIFICATION_PENDING:
    "A clarification request is already waiting for the requester's answer.",
};

export function errorText(error: unknown) {
  return error instanceof ApiError
    ? (errors[error.code] ??
        "The action could not be confirmed. Keep a copy of your entries, then reload and check the record before retrying.")
    : "No reliable response was received, so the result is unknown. Keep a copy of your entries, then check your connection and reload to see whether the action was recorded.";
}

export function prepareModel(
  job: { current: boolean; status: string; jobId: string } | null | undefined,
  input: {
    purpose: "intake_interpret" | "asset_match" | "risk_assess";
    draftId: string;
    requestId?: string;
  },
) {
  return job?.current && ["failed", "capped"].includes(job.status)
    ? api("/api/models/" + job.jobId, {})
    : api("/api/models", input);
}
