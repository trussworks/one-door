// These declarations let the TypeScript checker see the helpers the focused
// test imports from the plain-JavaScript acceptance program.
export type CheckStatus = "pass" | "fail" | "limit";

export interface CheckResult {
  check: string;
  status: CheckStatus;
  detail?: unknown;
}

export interface Summary {
  pass: number;
  fail: number;
  limit: number;
  checks: number;
  complete: boolean;
  exitCode: number;
}

export interface RefusalOutcome {
  succeeded: boolean;
  code: string;
}

export interface FutureObjectPrivileges {
  runtime_insert: boolean;
  runtime_select: boolean;
  runtime_update: boolean;
  runtime_delete: boolean;
  runtime_sequence: boolean;
  diagnostic_select: boolean;
  diagnostic_insert: boolean;
}

export function errorCode(error: unknown): string;
export function summarize(results: CheckResult[]): Summary;
export function judgeRefusal(
  expectedCodes: string[],
  outcome: RefusalOutcome,
): { status: CheckStatus; detail: Record<string, unknown> };
export function futureObjectsAreUsable(
  observed: FutureObjectPrivileges,
): boolean;
export function runAcceptance(env?: NodeJS.ProcessEnv): Promise<Summary>;
