export const workflowErrorCodes = [
  "NOT_FOUND",
  "NOT_OWNER",
  "INVALID_STATE",
  "VERSION_CONFLICT",
  "VALIDATION_FAILED",
  "CLARIFICATION_PENDING",
  "NO_OPEN_CLARIFICATION",
  "APPROVAL_BLOCKED",
  "RESOLUTION_BLOCKED",
] as const;

export type WorkflowErrorCode = (typeof workflowErrorCodes)[number];

/**
 * Stable machine-readable failure. `code` is the contract for HTTP handlers;
 * `detail` is developer diagnostics, never customer-facing prose.
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly detail?: string;

  constructor(code: WorkflowErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "WorkflowError";
    this.code = code;
    this.detail = detail;
  }
}
