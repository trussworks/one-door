import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  anthropicProvider,
  defaultModel,
  maxOutputTokens,
  reservedCostMicros,
  reservationTokenBound,
  resolveRates,
} from "../src/models/provider.ts";
import { validateOutput } from "../src/models/worker.ts";
import { modelPrompts } from "../src/models/prompts.ts";
import {
  providerOutputSchema,
  resultSchemas,
} from "../src/models/contracts.ts";

afterEach(() => vi.unstubAllEnvs());
it("constrains identifiers to the supplied corpus without accepting an unknown citation locally", () => {
  const service = "10000000-0000-4000-8000-000000000001";
  const asset = "20000000-0000-4000-8000-000000000002";
  const refs = {
    offeringIds: new Set([service]),
    catalogItemIds: new Set([asset]),
    offeringKeys: new Set(["known-service"]),
    policyRuleIds: new Set<string>(),
  };
  const schema = JSON.parse(
    JSON.stringify(providerOutputSchema("intake_interpret", refs)),
  );
  expect(schema.properties.services.items.properties.offeringId.enum).toEqual([
    service,
  ]);
  expect(schema.properties.assets.items.properties.catalogItemId.enum).toEqual([
    asset,
  ]);
  expect(
    schema.properties.services.items.properties.relatedOfferingKeys.items.enum,
  ).toEqual(["known-service"]);
  expect(
    schema.properties.requesterSuggestion.anyOf.find(
      (part: { type: string }) => part.type === "object",
    ).properties.id.enum,
  ).toEqual([service, asset]);
  const output = {
    outputText: JSON.stringify({
      candidates: [
        {
          catalogItemId: service,
          fitBand: "strong",
          coverage: [],
          gaps: [],
          dependencies: [],
          rationale: "Wrong identifier kind",
        },
      ],
    }),
    inputTokens: 1,
    outputTokens: 1,
  };
  expect(validateOutput("asset_match", refs, output)).toEqual({
    error: "unknown_identifier",
  });
  const empty = {
    offeringIds: new Set<string>(),
    catalogItemIds: new Set<string>(),
    offeringKeys: new Set<string>(),
    policyRuleIds: new Set<string>(),
  };
  expect(
    validateOutput("asset_match", empty, {
      ...output,
      outputText: '{"candidates":[]}',
    }),
  ).toEqual({ purpose: "asset_match", validated: { candidates: [] } });
  expect(
    JSON.stringify(providerOutputSchema("asset_match", empty)),
  ).not.toContain('"enum":[]');
});
const citationIds = {
  service: "10000000-0000-4000-8000-000000000001",
  asset: "20000000-0000-4000-8000-000000000002",
  policy: "30000000-0000-4000-8000-000000000003",
};
const candidate = {
  catalogItemId: citationIds.asset,
  fitBand: "strong",
  coverage: [],
  gaps: [],
  dependencies: [],
  rationale: "An eligible existing asset",
};
const validOutputs = {
  intake_interpret: {
    content: {
      title: "A request",
      problem: "A need",
      affectedPeople: "A team",
      acceptanceCriteria: [],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    questions: [],
    services: [
      {
        offeringId: citationIds.service,
        fitBand: "strong",
        coverage: [],
        gaps: [],
        relatedOfferingKeys: ["known-service"],
        rationale: "An eligible service",
      },
    ],
    assets: [candidate],
    requesterSuggestion: {
      kind: "asset",
      id: citationIds.asset,
      summary: "Use this asset",
      conditions: [],
    },
  },
  asset_match: { candidates: [candidate] },
  risk_assess: {
    findings: [
      {
        policyRuleId: citationIds.policy,
        kind: "supported_risk",
        evidence: "A recorded fact",
        missingInformation: null,
        proposedSeverity: "low",
        rationale: "The cited rule applies",
      },
    ],
  },
};
it.each(["intake_interpret", "asset_match", "risk_assess"] as const)(
  "retains the %s result type and checks citations against their own domain",
  (purpose) => {
    const references = {
      offeringIds: new Set([citationIds.service]),
      catalogItemIds: new Set([citationIds.asset]),
      policyRuleIds: new Set([citationIds.policy]),
      offeringKeys: new Set(["known-service"]),
    };
    const output = {
      inputTokens: 1,
      outputTokens: 1,
      outputText: JSON.stringify(validOutputs[purpose]),
    };
    expect(validateOutput(purpose, references, output)).toEqual({
      purpose,
      validated: validOutputs[purpose],
    });
    expect(
      validateOutput(
        purpose,
        {
          offeringIds: new Set([citationIds.asset]),
          catalogItemIds: new Set([citationIds.policy]),
          policyRuleIds: new Set([citationIds.service]),
          offeringKeys: references.offeringKeys,
        },
        output,
      ),
    ).toEqual({ error: "unknown_identifier" });
  },
);

it("retains output-limit evidence and usage from the real transport contract", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", randomBytes(24).toString("hex"));
  let sent: Record<string, unknown> | undefined;
  const provider = anthropicProvider(async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: '{"findings":[]}' }],
      usage: { input_tokens: 50, output_tokens: maxOutputTokens },
    });
  });
  const result = await provider.complete({
    model: defaultModel,
    system: "rules",
    input: "need",
    maxOutputTokens,
    outputSchema: providerOutputSchema("risk_assess"),
  });
  expect(sent?.max_tokens).toBe(8192);
  expect(sent?.output_config).toEqual({
    format: {
      type: "json_schema",
      schema: providerOutputSchema("risk_assess"),
    },
    effort: "high",
  });
  expect(result.stopReason).toBe("max_tokens");
  expect(result.outputTokens).toBe(8192);
  expect(
    validateOutput(
      "risk_assess",
      {
        offeringIds: new Set(),
        offeringKeys: new Set(),
        policyRuleIds: new Set<string>(),
        catalogItemIds: new Set(),
      },
      result,
    ),
  ).toEqual({ error: "provider_output_limit" });
});
it("runs intake at medium effort and the deeper evaluations at high", () => {
  expect(modelPrompts.intake_interpret.effort).toBe("medium");
  expect(modelPrompts.asset_match.effort).toBe("high");
  expect(modelPrompts.risk_assess.effort).toBe("high");
});

it("merges a caller's effort into output_config beside the schema and keeps max_tokens", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", randomBytes(24).toString("hex"));
  const schema = providerOutputSchema("intake_interpret");
  async function bodyFor(effort?: "medium" | "high") {
    let sent: Record<string, unknown> | undefined;
    const provider = anthropicProvider(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    await provider.complete({
      model: defaultModel,
      system: "rules",
      input: "need",
      maxOutputTokens,
      outputSchema: schema,
      ...(effort ? { effort } : {}),
    });
    return sent;
  }
  const medium = await bodyFor("medium");
  expect(medium?.output_config).toEqual({
    format: { type: "json_schema", schema },
    effort: "medium",
  });
  expect(medium?.max_tokens).toBe(8192);
  const high = await bodyFor("high");
  expect((high?.output_config as { effort: string }).effort).toBe("high");
  const omitted = await bodyFor();
  expect(omitted?.output_config).toEqual(high?.output_config);
});

it("reserves the full configured output allowance and accepts a complete response", () => {
  const rates = resolveRates(defaultModel);
  const schema = providerOutputSchema("risk_assess");
  expect(reservedCostMicros(rates, "input", schema)).toBe(
    reservationTokenBound("input" + JSON.stringify(schema)) *
      rates.inputMicrosPerToken +
      maxOutputTokens * rates.outputMicrosPerToken,
  );
  expect(
    validateOutput(
      "risk_assess",
      {
        offeringIds: new Set(),
        offeringKeys: new Set(),
        policyRuleIds: new Set<string>(),
        catalogItemIds: new Set(),
      },
      {
        outputText: '{"findings":[]}',
        inputTokens: 50,
        outputTokens: 8,
        stopReason: "end_turn",
      },
    ),
  ).toEqual({ purpose: "risk_assess", validated: { findings: [] } });
});

it("uses the supported structured-output schema subset without relaxing local validation", () => {
  for (const purpose of [
    "intake_interpret",
    "asset_match",
    "risk_assess",
  ] as const) {
    const schema = providerOutputSchema(purpose);
    const encoded = JSON.stringify(schema);
    expect(encoded).not.toMatch(/"(?:minLength|maxLength|maxItems)":\d/);
    expect(schema.additionalProperties).toBe(false);
  }
  const candidate = {
    catalogItemId: "b0bba5f0-a9f1-46df-a7c1-5b82e87ef416",
    fitBand: "strong",
    coverage: [],
    gaps: [],
    dependencies: [],
    rationale: "A supported test proposal",
  };
  expect(
    resultSchemas.asset_match.safeParse({
      candidates: Array(5).fill(candidate),
    }).success,
  ).toBe(true);
  expect(
    resultSchemas.asset_match.safeParse({
      candidates: Array(6).fill(candidate),
    }).success,
  ).toBe(false);
  expect(
    resultSchemas.risk_assess.safeParse({
      findings: [
        {
          policyRuleId: "b0bba5f0-a9f1-46df-a7c1-5b82e87ef416",
          kind: "missing_information",
          missingInformation: "Unknown",
          evidence: "Contradicts its kind",
          proposedSeverity: "high",
          rationale: "Known mismatch",
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    validateOutput(
      "risk_assess",
      {
        offeringIds: new Set(),
        offeringKeys: new Set(),
        policyRuleIds: new Set<string>(),
        catalogItemIds: new Set(),
      },
      {
        outputText: '{"findings":[]}',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: "refusal",
      },
    ),
  ).toEqual({ error: "provider_refusal" });
});
