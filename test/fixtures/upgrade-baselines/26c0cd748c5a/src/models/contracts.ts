import { createHash } from "node:crypto";

import { z } from "zod";

import { modelPurposes } from "../domain/constants.ts";

export type ModelPurpose = (typeof modelPurposes)[number];

/**
 * Validated result contracts for the three model purposes. The shapes mirror
 * the output specifications in prompts.ts exactly; anything else is a bad
 * output, never a stored proposal.
 */

const line = (max: number) => z.string().trim().min(1).max(max);
const lines = z.array(z.string().max(500)).max(30);
const fitBand = z.enum(["strong", "possible", "weak"]);

export const intakeResultSchema = z.object({
  content: z
    .object({
      title: line(200),
      problem: line(5000),
      affectedPeople: line(2000),
      acceptanceCriteria: lines.max(20),
      requirements: lines,
      constraints: lines,
      unknowns: lines,
    })
    .refine(
      (content) =>
        Object.entries(content).every(
          ([key, value]) =>
            !Array.isArray(value) ||
            value
              .flatMap((item) => item.split("\n"))
              .filter((item) => item.trim()).length <=
              (key === "acceptanceCriteria" ? 20 : 30),
        ),
      "Expanded list items must fit the request record",
    ),
  questions: z.array(line(500)).max(3),
  services: z
    .array(
      z.object({
        offeringId: z.string().uuid(),
        fitBand,
        coverage: lines,
        gaps: lines,
        relatedOfferingKeys: z.array(z.string().max(200)).max(10),
        rationale: line(2000),
      }),
    )
    .max(3),
  /** Existing-asset evaluation from the same combined call; reviewer-facing. */
  assets: z
    .array(
      z.object({
        catalogItemId: z.string().uuid(),
        fitBand,
        coverage: lines,
        gaps: lines,
        dependencies: lines,
        rationale: line(2000),
      }),
    )
    .max(5)
    .default([]),
  /**
   * At most one genuinely strong whole-need suggestion the requester may
   * see. Null whenever fit is partial, uncertain, or a technical tradeoff
   * exists; the reviewer always gets the full candidate lists regardless.
   */
  requesterSuggestion: z
    .object({
      kind: z.enum(["service", "asset"]),
      id: z.string().uuid(),
      summary: line(300),
      conditions: z.array(z.string().max(160)).max(2),
    })
    .nullable()
    .default(null),
});
export type IntakeResult = z.infer<typeof intakeResultSchema>;

export const assetResultSchema = z.object({
  candidates: z
    .array(
      z.object({
        catalogItemId: z.string().uuid(),
        fitBand,
        coverage: lines,
        gaps: lines,
        dependencies: lines,
        rationale: line(2000),
      }),
    )
    .max(5),
});
export type AssetResult = z.infer<typeof assetResultSchema>;

const findingBase = {
  policyRuleId: z.string().uuid(),
  rationale: line(2000),
};
export const riskResultSchema = z.object({
  findings: z
    .array(
      z.union([
        z.object({
          ...findingBase,
          kind: z.literal("supported_risk"),
          evidence: line(2000),
          missingInformation: z.null(),
          proposedSeverity: z.enum(["low", "moderate", "high", "critical"]),
        }),
        z.object({
          ...findingBase,
          kind: z.literal("missing_information"),
          evidence: z.null(),
          missingInformation: line(2000),
          proposedSeverity: z.null(),
        }),
      ]),
    )
    .max(20),
});
export type RiskResult = z.infer<typeof riskResultSchema>;

export const resultSchemas = {
  intake_interpret: intakeResultSchema,
  asset_match: assetResultSchema,
  risk_assess: riskResultSchema,
} as const;

/** JSON with recursively sorted object keys, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Vendor-supported grammar constraints; the original schemas still validate every result. */
export function providerOutputSchema(
  purpose: ModelPurpose,
  references?: {
    eligibleIds: ReadonlySet<string>;
    eligibleKeys: ReadonlySet<string>;
    eligibleAssetIds: ReadonlySet<string>;
  },
) {
  const schema = z.toJSONSchema(resultSchemas[purpose], {
    target: "draft-07",
    reused: "inline",
    override: ({ jsonSchema }) => {
      const bounds: Record<string, unknown> = {};
      for (const key of ["minLength", "maxLength", "maxItems"] as const) {
        if (jsonSchema[key] !== undefined) {
          bounds[key] = jsonSchema[key];
          delete jsonSchema[key];
        }
      }
      if (Object.keys(bounds).length)
        jsonSchema.description =
          "Application-validated bounds: " + JSON.stringify(bounds);
      if (jsonSchema.format === "uuid") delete jsonSchema.pattern;
    },
  });
  delete schema.$schema;
  if (references)
    bindReferenceEnums(schema, {
      offeringId: [...references.eligibleIds],
      catalogItemId: [
        ...(purpose === "intake_interpret"
          ? references.eligibleAssetIds
          : references.eligibleIds),
      ],
      policyRuleId: [...references.eligibleIds],
      relatedOfferingKeys: [...references.eligibleKeys],
      id: [...references.eligibleIds, ...references.eligibleAssetIds],
    });
  return schema;
}

/** Constrain citations during generation as well as validating them afterward. */
function bindReferenceEnums(
  schema: unknown,
  references: Record<string, string[]>,
) {
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    const values = references[key];
    if (values?.length && value && typeof value === "object") {
      const field = value as Record<string, unknown>;
      const citation =
        key === "relatedOfferingKeys"
          ? (field.items as Record<string, unknown>)
          : field;
      citation.enum = [...values].sort();
    }
    bindReferenceEnums(value, references);
  }
}
