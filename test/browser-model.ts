import { setTimeout as pause } from "node:timers/promises";
import type { ModelProvider } from "../src/models/provider.ts";

export const fieldNeed =
  "Field survey teams visit landslide sites and record rock types, GPS locations, and the condition of samples on paper. The sites have no network connection. We need a way to capture these observations offline and let other teams view the findings when the field team returns. We are not connecting to an existing system. The current paper form needs to be replaced, but we do not know which service or product would cover the whole workflow.";

interface Need {
  rawNeed?: string;
  content: Record<string, unknown>;
  turns?: Array<{ question: string; answer: string }>;
}
type RecordRow = Record<string, unknown>;

export const browserModel: ModelProvider = {
  async complete({ input, outputSchema }) {
    const { need, records } = JSON.parse(input) as {
      need: Need;
      records: RecordRow[];
    };
    if (need.rawNeed?.includes("Slow demonstration")) await pause(2500);
    if (need.rawNeed?.includes("Fail assistance"))
      throw new Error("provider_timeout");
    const properties = outputSchema.properties as Record<string, unknown>;
    let output: unknown;
    if (properties.services) output = intake(need, records);
    else if (properties.candidates)
      output = { candidates: assetCandidates(records) };
    else output = { findings: riskFindings(records) };
    return {
      outputText: JSON.stringify(output),
      inputTokens: 100,
      outputTokens: 100,
    };
  },
};

function intake(need: Need, records: RecordRow[]) {
  const field = Boolean(need.rawNeed?.includes("landslide"));
  const answered = Boolean(need.turns?.length);
  const strong = Boolean(need.rawNeed?.includes("Strong fit demonstration"));
  const offering = records.find(
    (row) =>
      row.offeringKey ===
      (field ? "mobile-field-inspection" : "azure-application-deployment"),
  );
  const content = {
    ...(field ? fieldContent() : cloudContent()),
    ...need.content,
  };
  if (answered && field) {
    content.acceptanceCriteria = [
      "Other teams can find and view each submitted field report",
    ];
    content.requirements = [
      "Record rock type, GPS coordinates, and sample condition offline",
    ];
    content.unknowns = [];
  }
  return {
    content,
    questions: intakeQuestions(need, field, answered),
    services: serviceCandidates(offering, strong),
    assets: assetCandidates(records),
    requesterSuggestion:
      strong && offering
        ? {
            kind: "service",
            id: offering.offeringId,
            summary:
              "OIT's cloud deployment service can provide the approved environment and operating handoff for your application.",
            conditions: [
              "OIT will confirm suitability and required approvals.",
            ],
          }
        : null,
  };
}

function serviceCandidates(offering: RecordRow | undefined, strong: boolean) {
  return offering
    ? [
        {
          offeringId: offering.offeringId,
          fitBand: strong ? "strong" : "possible",
          coverage: ["An OIT service path for the requested work"],
          gaps: strong
            ? []
            : ["The complete program workflow still needs OIT review"],
          relatedOfferingKeys: [],
          rationale:
            "The service can support part of this need, but a partial capability is not a complete solution. OIT must verify the remaining workflow and any required connections before choosing the delivery path.",
        },
      ]
    : [];
}

function intakeQuestions(need: Need, field: boolean, answered: boolean) {
  if (answered) return [];
  if (field)
    return [
      "Which details are on the current paper form?",
      "What do other teams need to do with the findings?",
    ];
  return need.rawNeed?.includes("Ask for additional details")
    ? [
        "Who needs to use the application?",
        "What would a successful launch allow them to do?",
      ]
    : [];
}

function fieldContent() {
  return {
    title: "Record landslide findings offline",
    problem:
      "Capture landslide observations without a network connection and share the findings with other teams.",
    affectedPeople: "Field survey teams and teams using their findings",
    acceptanceCriteria: [
      "Record observations at sites without connectivity",
      "Other teams can view the findings after the team returns",
    ],
    requirements: [
      "Capture rock type, location, and sample condition",
      "Keep field entries until a connection is available",
    ],
    constraints: [
      "Field sites have no connectivity",
      "No existing system is being integrated",
    ],
    unknowns: [
      "The full contents of the paper form",
      "How other teams need to use the findings",
    ],
  };
}

function cloudContent() {
  return {
    title: "Deploy the Budget Office forecasting app",
    problem:
      "Run the forecasting application in an approved cloud environment with agency sign-in and recoverable data.",
    affectedPeople: "Budget Office analysts",
    acceptanceCriteria: [
      "Staff can sign in and submit forecasts",
      "A database backup can be restored",
    ],
    requirements: ["Agency sign-in", "A managed cloud environment"],
    constraints: ["Fictional aggregate data only"],
    unknowns: [],
  };
}

function assetCandidates(records: RecordRow[]) {
  const row = records.find(
    (record) => record.itemKey === "colorado-azure-landing-zone",
  );
  if (!row) return [];
  return [
    {
      catalogItemId: row.catalogItemId,
      fitBand: "possible",
      coverage: [
        "Provides a managed deployment environment",
        "Supports a governed publishing layer for downstream applications",
      ],
      gaps: [
        "It does not provide the requested field capture or viewing workflow",
        "The connection to field data has not been verified",
      ],
      dependencies: [
        "A working field data source and a separately designed viewing interface",
      ],
      rationale:
        "This platform could form a governed publishing layer between collected data and an analysis interface, but the catalog record does not establish the required integration. It does not provide the requested end-user workflow itself. OIT needs to evaluate the data path and the application requirements before treating this supporting component as a solution.",
    },
  ];
}

function riskFindings(records: RecordRow[]) {
  const row = records.find((record) => record.policyRuleId);
  return row
    ? [
        {
          policyRuleId: row.policyRuleId,
          kind: "supported_risk",
          evidence: "The request requires agency sign-in",
          missingInformation: null,
          proposedSeverity: "low",
          rationale:
            "Controlled browser-test finding; not a real policy assessment.",
        },
      ]
    : [];
}
