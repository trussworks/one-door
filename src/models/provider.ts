import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Missing provider usage stays null; estimates are not measured usage.
export interface ModelProviderResult {
  outputText: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason?: string | null;
}

export interface ModelProvider {
  complete(args: {
    model: string;
    system: string;
    input: string;
    maxOutputTokens: number;
    outputSchema: Record<string, unknown>;
    effort?: "medium" | "high";
  }): Promise<ModelProviderResult>;
}

/**
 * Micro-dollars per token. A model outside this map cannot run without
 * caller-validated rates: unpriced spend is never silent.
 * claude-sonnet-5 pricing verified at
 * https://platform.claude.com/docs/en/about-claude/pricing ($2/M in, $10/M out).
 */
export const modelPricing: Record<
  string,
  { inputMicrosPerToken: number; outputMicrosPerToken: number }
> = {
  "claude-sonnet-5": { inputMicrosPerToken: 2, outputMicrosPerToken: 10 },
};

export const defaultModel = "claude-sonnet-5";
export const maxOutputTokens = 8192;
/** Under the 120-second worker lease, so a hung call cannot outlive it. */
export const requestTimeoutMs = 100_000;
/** Covers message framing and tokenizer variance beyond the text itself. */
const reservationOverheadTokens = 1000;

export interface ModelRates {
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
}

export function resolveRates(
  model: string,
  validatedRates?: ModelRates,
): ModelRates {
  const rates = modelPricing[model] ?? validatedRates;
  if (
    !rates ||
    !Number.isFinite(rates.inputMicrosPerToken) ||
    !Number.isFinite(rates.outputMicrosPerToken) ||
    rates.inputMicrosPerToken < 0 ||
    rates.outputMicrosPerToken < 0
  ) {
    throw new Error(
      `model "${model}" has no known price mapping; supply validated rates`,
    );
  }
  return rates;
}

/**
 * Reservation upper bound: one token per UTF-8 byte. Real tokenizers emit
 * far fewer, including for multilingual and token-dense text, so the hard
 * caps cannot be exceeded; actual usage reconciles the ledger downward.
 */
export function reservationTokenBound(text: string): number {
  return Buffer.byteLength(text, "utf8") + reservationOverheadTokens;
}

export function reservedCostMicros(
  rates: ModelRates,
  inputText: string,
  outputSchema: Record<string, unknown>,
): number {
  return (
    reservationTokenBound(inputText + JSON.stringify(outputSchema)) *
      rates.inputMicrosPerToken +
    maxOutputTokens * rates.outputMicrosPerToken
  );
}

export function actualCostMicros(
  rates: ModelRates,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    inputTokens * rates.inputMicrosPerToken +
    outputTokens * rates.outputMicrosPerToken
  );
}

/** A reported count is usable only as a nonnegative finite integer. */
export function validTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * The key comes from ANTHROPIC_API_KEY, else the macOS Keychain service
 * 'anthropic-api'. The value is returned to the transport only: never log,
 * print, or persist it.
 */
export async function resolveApiKey(): Promise<string> {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("security", [
        "find-generic-password",
        "-s",
        "anthropic-api",
        "-w",
      ]);
      const key = stdout.trim();
      if (key.length > 0) return key;
    } catch {
      // fall through to the explicit error below
    }
  }
  throw new Error(
    "model credentials unavailable: set ANTHROPIC_API_KEY or store Keychain item 'anthropic-api'",
  );
}

type FetchLike = typeof fetch;

// Transport exceptions may contain request content or credentials, including in
// their causes; translate them without retaining the original exception.
function sanitizedTransportError(error: unknown): Error {
  const timeout =
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name);
  return new Error(timeout ? "provider_timeout" : "provider_network_error");
}

// Reject redirects to protect the API key; expose safe codes, not provider error bodies.
export function anthropicProvider(fetchImpl: FetchLike = fetch): ModelProvider {
  return {
    async complete({
      model,
      system,
      input,
      maxOutputTokens: maxTokens,
      outputSchema,
      effort = "high",
    }) {
      const apiKey = await resolveApiKey();
      let response: Response;
      try {
        response = await fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            output_config: {
              format: { type: "json_schema", schema: outputSchema },
              effort,
            },
            messages: [{ role: "user", content: input }],
          }),
          redirect: "error",
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw sanitizedTransportError(error);
      }
      if (!response.ok) {
        // The body may echo request content; keep the error to status only.
        throw new Error(`provider_http_${response.status}`);
      }
      const body = (await response.json()) as {
        stop_reason?: string;
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      const text = (body.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      return {
        outputText: text,
        inputTokens: validTokenCount(body.usage?.input_tokens),
        outputTokens: validTokenCount(body.usage?.output_tokens),
        stopReason: body.stop_reason,
      };
    },
  };
}
