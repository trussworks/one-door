import type { RequestStage } from "../domain/constants.ts";

export interface ScenarioFixture {
  requesterActorKey: string;
  organizationKey: string;
  serviceOfferingKey: string | null;
  stage: RequestStage;
}

export const scenarioFixtures = {
  "disclosure-backlog": {
    requesterActorKey: "marcus-oyelaran",
    organizationKey: "state-archivist",
    serviceOfferingKey: "records-disclosure-management",
    stage: "under_review",
  },
  "inspector-paper-checklists": {
    requesterActorKey: "tobias-vance",
    organizationKey: "environmental-quality",
    serviceOfferingKey: "mobile-field-inspection",
    stage: "first_review_completed",
  },
  "funding-panel-scoring-drift": {
    requesterActorKey: "leila-morgan",
    organizationKey: "state-comptroller",
    serviceOfferingKey: "grants-program-administration",
    stage: "under_review",
  },
  "no-idea-which-form-applies": {
    requesterActorKey: "nadia-brant",
    organizationKey: "constituent-services",
    serviceOfferingKey: null,
    stage: "submitted",
  },
  "notices-only-in-english": {
    requesterActorKey: "avery-brooks",
    organizationKey: "community-health",
    serviceOfferingKey: "language-access-remediation",
    stage: "under_review",
  },
  "which-procedure-copy-is-real": {
    requesterActorKey: "marcus-oyelaran",
    organizationKey: "state-archivist",
    serviceOfferingKey: "content-governance",
    stage: "first_review_completed",
  },
  "permissions-outlive-the-job": {
    requesterActorKey: "priya-raman",
    organizationKey: "labor-employment",
    serviceOfferingKey: "identity-access-governance",
    stage: "under_review",
  },
  "no-number-for-how-it-went": {
    requesterActorKey: "nadia-brant",
    organizationKey: "constituent-services",
    serviceOfferingKey: "service-feedback-measurement",
    stage: "first_review_completed",
  },
  "callers-asking-where-it-stands": {
    requesterActorKey: "priya-raman",
    organizationKey: "labor-employment",
    serviceOfferingKey: "applicant-status-communications",
    stage: "under_review",
  },
  "levee-settlement-imagery": {
    requesterActorKey: "rowan-kim",
    organizationKey: "natural-resources",
    serviceOfferingKey: null,
    stage: "submitted",
  },
  "retiring-benefit-calculation": {
    requesterActorKey: "avery-brooks",
    organizationKey: "community-health",
    serviceOfferingKey: null,
    stage: "under_review",
  },
  "subscriptions-renewed-unnoticed": {
    requesterActorKey: "leila-morgan",
    organizationKey: "state-comptroller",
    serviceOfferingKey: "contract-subscription-oversight",
    stage: "under_review",
  },
  "budget-office-azure-deployment": {
    requesterActorKey: "samira-holt",
    organizationKey: "budget-office",
    serviceOfferingKey: "azure-application-deployment",
    stage: "under_review",
  },
} satisfies Record<string, ScenarioFixture>;
