import type {
  actors,
  assetAssessments,
  assetCandidateDecisions,
  assetCandidates,
  auditEvents,
  catalogFieldDecisions,
  catalogItems,
  catalogItemSources,
  draftTurns,
  drafts,
  externalWorkItems,
  inventoryAliases,
  inventoryConflictMembers,
  inventoryConflicts,
  inventorySourceRecords,
  inventorySources,
  inventorySyncRuns,
  modelCalls,
  organizations,
  policyRules,
  requestWorkItemLinks,
  requests,
  reviewTasks,
  riceScores,
  riskAssessments,
  riskFindingDecisions,
  riskFindings,
  serviceCandidates,
  serviceOfferings,
  taskCompletions,
  visitors,
  wip,
  workSyncRuns,
  workSystems,
} from "../db/schema.ts";
import type { RiskDomain } from "../domain/constants.ts";

export interface CatalogItem {
  key: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  capabilities: string[];
  ownerOffice: string;
  licenseModel: "enterprise" | "site" | "seat" | "open_source";
  seatCount: number | null;
  approvalStatus: "approved" | "pilot" | "retiring";
  dataTypes: Array<"public" | "internal" | "confidential" | "restricted">;
  integrations: string[];
  renewalDate: string | null;
}

export interface PolicyRule {
  code: string;
  domain: RiskDomain;
  title: string;
  rule: string;
  triggerTerms: string[];
  defaultSeverity: "low" | "moderate" | "high" | "critical";
  citation: string;
}

export interface ConversationTurn {
  actor: "submitter" | "assistant";
  content: string;
}

export interface RiceDraft {
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
}

export interface RequestScenario {
  key: string;
  seedOrdinal: number;
  title: string;
  problem: string;
  affectedUsers: string;
  successMetrics: string[];
  requirements: string[];
  constraints: string[];
  conversation: ConversationTurn[];
  expectedCatalogMatches: string[];
  rejectedCatalogMatches?: string[];
  expectedPolicyRules: string[];
  expectedNoMatch?: boolean;
  riceDraft: RiceDraft;
  riceReviewed?: RiceDraft;
}

export interface SeedUser {
  key: string;
  name: string;
  email: string;
  role: "submitter" | "reviewer";
  office: string;
}

export interface SeedData {
  organizations: Array<typeof organizations.$inferInsert>;
  actors: Array<typeof actors.$inferInsert>;
  visitors: Array<typeof visitors.$inferInsert>;
  wip: Array<typeof wip.$inferInsert>;
  auditEvents: Array<typeof auditEvents.$inferInsert>;
  serviceOfferings: Array<typeof serviceOfferings.$inferInsert>;
  drafts: Array<typeof drafts.$inferInsert>;
  modelCalls: Array<typeof modelCalls.$inferInsert>;
  draftTurns: Array<typeof draftTurns.$inferInsert>;
  serviceCandidates: Array<typeof serviceCandidates.$inferInsert>;
  requests: Array<typeof requests.$inferInsert>;
  taskCompletions: Array<typeof taskCompletions.$inferInsert>;
  inventorySources: Array<typeof inventorySources.$inferInsert>;
  inventorySyncRuns: Array<typeof inventorySyncRuns.$inferInsert>;
  inventorySourceRecords: Array<typeof inventorySourceRecords.$inferInsert>;
  inventoryAliases: Array<typeof inventoryAliases.$inferInsert>;
  inventoryConflicts: Array<typeof inventoryConflicts.$inferInsert>;
  inventoryConflictMembers: Array<typeof inventoryConflictMembers.$inferInsert>;
  catalogItems: Array<typeof catalogItems.$inferInsert>;
  catalogFieldDecisions: Array<typeof catalogFieldDecisions.$inferInsert>;
  catalogItemSources: Array<typeof catalogItemSources.$inferInsert>;
  reviewTasks: Array<typeof reviewTasks.$inferInsert>;
  assetAssessments: Array<typeof assetAssessments.$inferInsert>;
  assetCandidates: Array<typeof assetCandidates.$inferInsert>;
  assetCandidateDecisions: Array<typeof assetCandidateDecisions.$inferInsert>;
  policyRules: Array<typeof policyRules.$inferInsert>;
  riskAssessments: Array<typeof riskAssessments.$inferInsert>;
  riskFindings: Array<typeof riskFindings.$inferInsert>;
  riskFindingDecisions: Array<typeof riskFindingDecisions.$inferInsert>;
  riceScores: Array<typeof riceScores.$inferInsert>;
  workSystems: Array<typeof workSystems.$inferInsert>;
  workSyncRuns: Array<typeof workSyncRuns.$inferInsert>;
  externalWorkItems: Array<typeof externalWorkItems.$inferInsert>;
  requestWorkItemLinks: Array<typeof requestWorkItemLinks.$inferInsert>;
}
