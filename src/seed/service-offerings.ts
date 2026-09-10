export interface SeedServiceOffering {
  key: string;
  name: string;
  description: string;
  ownerOrganizationKey: string;
  capabilities: string[];
  prerequisites: string[];
  reviewDate: string;
}

export const seedServiceOfferings = [
  {
    key: "azure-application-deployment",
    name: "Deploy an agency application to Colorado Azure",
    description:
      "Coordinates the approved cloud environment, application identity, delivery pipeline, security review, logging, and operating handoff needed to run an agency application in Colorado Azure.",
    ownerOrganizationKey: "platform-enablement",
    capabilities: [
      "Colorado Azure environment",
      "application identity and secrets",
      "delivery pipeline",
      "security and architecture review",
      "application observability",
      "production ownership",
    ],
    prerequisites: [
      "Named agency product owner",
      "Application source and deployment instructions",
      "Initial data classification",
    ],
    reviewDate: "2027-03-31",
  },
  {
    key: "application-identity-secrets",
    name: "Establish application identity and secrets",
    description:
      "Creates managed application identity, approved secret storage, access boundaries, and rotation ownership for an application that already has a hosting and delivery path.",
    ownerOrganizationKey: "enterprise-security",
    capabilities: [
      "managed application identity",
      "secret storage",
      "credential rotation",
      "access boundary review",
    ],
    prerequisites: [
      "Known application owner",
      "Known target environment",
      "List of required system connections",
    ],
    reviewDate: "2027-02-28",
  },
  {
    key: "delivery-pipeline-enablement",
    name: "Set up an approved application delivery pipeline",
    description:
      "Provides a managed repository and build, test, security-scan, approval, and release path for an application whose target environment is already approved.",
    ownerOrganizationKey: "platform-enablement",
    capabilities: [
      "managed source repository",
      "automated build and test",
      "security scanning",
      "release approval",
      "deployment history",
    ],
    prerequisites: [
      "Approved target environment",
      "Named release owner",
      "Repeatable application build",
    ],
    reviewDate: "2027-03-31",
  },
  {
    key: "records-disclosure-management",
    name: "Manage records and disclosure requests",
    description:
      "Coordinates official-record storage, retention, legal hold, disclosure deadlines, redaction, approval, and release evidence for a program office.",
    ownerOrganizationKey: "state-archivist",
    capabilities: [
      "records retention",
      "disclosure request workflow",
      "legal hold",
      "redaction",
      "release evidence",
    ],
    prerequisites: [
      "Named records custodian",
      "Applicable retention schedule",
      "Counsel approval path",
    ],
    reviewDate: "2027-06-30",
  },
  {
    key: "mobile-field-inspection",
    name: "Digitize a mobile field inspection",
    description:
      "Designs an offline-capable inspection workflow, reference-data download, evidence capture, synchronization, and connection to the program’s permitting or asset record.",
    ownerOrganizationKey: "environmental-quality",
    capabilities: [
      "offline field forms",
      "photograph and location capture",
      "reference data download",
      "return synchronization",
      "inspection record integration",
    ],
    prerequisites: [
      "Current paper checklist",
      "Named source system",
      "Field connectivity constraints",
    ],
    reviewDate: "2027-05-31",
  },
  {
    key: "grants-program-administration",
    name: "Administer a competitive grant program",
    description:
      "Supports opportunity publication, application review, panel assignment, rubric scoring, calibration, award records, and post-award monitoring.",
    ownerOrganizationKey: "state-comptroller",
    capabilities: [
      "grant opportunity intake",
      "panel assignment",
      "scoring rubric",
      "calibration",
      "award record",
      "subrecipient monitoring",
    ],
    prerequisites: [
      "Approved program rules",
      "Named grant owner",
      "Published evaluation criteria",
    ],
    reviewDate: "2027-04-30",
  },
  {
    key: "language-access-remediation",
    name: "Make public notices accessible across languages",
    description:
      "Coordinates plain-language review, qualified translation, accessible document production, approval, and publication for recurring public notices.",
    ownerOrganizationKey: "constituent-services",
    capabilities: [
      "language access planning",
      "qualified translation review",
      "plain-language editing",
      "accessible document remediation",
      "approved publication",
    ],
    prerequisites: [
      "Source notice templates",
      "Languages required by the served population",
      "Named content approver",
    ],
    reviewDate: "2027-01-31",
  },
  {
    key: "content-governance",
    name: "Establish authoritative procedures and document history",
    description:
      "Creates one current procedure record, keeps superseded versions, makes content searchable, transfers ownership, and records every governed change.",
    ownerOrganizationKey: "state-archivist",
    capabilities: [
      "authoritative copy",
      "version history",
      "superseded-record retention",
      "content search",
      "ownership transfer",
      "change evidence",
    ],
    prerequisites: [
      "Known procedure owners",
      "Existing document collection",
      "Retention requirement",
    ],
    reviewDate: "2027-06-30",
  },
  {
    key: "identity-access-governance",
    name: "Govern staff identity and system access",
    description:
      "Coordinates sign-on, entitlement inventory, joiner-mover-leaver changes, manager certification, revocation, and auditor-ready access evidence.",
    ownerOrganizationKey: "enterprise-security",
    capabilities: [
      "federated sign-on",
      "entitlement inventory",
      "automatic revocation",
      "manager certification",
      "access evidence",
    ],
    prerequisites: [
      "Named system owners",
      "Authoritative workforce source",
      "Current entitlement extracts",
    ],
    reviewDate: "2027-05-31",
  },
  {
    key: "applicant-status-communications",
    name: "Send applicants understandable status updates",
    description:
      "Connects case-stage changes to accessible, preference-aware messages and delivery evidence so applicants can understand progress without calling.",
    ownerOrganizationKey: "shared-services",
    capabilities: [
      "plain-language stage mapping",
      "email text and voice delivery",
      "channel preference",
      "delivery receipts",
      "case-system integration",
    ],
    prerequisites: [
      "Defined case stages",
      "Approved message templates",
      "Applicant communication preferences",
    ],
    reviewDate: "2027-02-28",
  },
  {
    key: "service-feedback-measurement",
    name: "Measure satisfaction at the end of a service",
    description:
      "Designs a short defensible satisfaction measure, connects it to a completed task, separates live from test responses, and reports comparable results over time.",
    ownerOrganizationKey: "constituent-services",
    capabilities: [
      "end-of-task survey",
      "sampling plan",
      "response deduplication",
      "live and test separation",
      "trend reporting",
    ],
    prerequisites: [
      "Defined task completion",
      "Named measurement owner",
      "Documented data-retention purpose",
    ],
    reviewDate: "2027-01-31",
  },
  {
    key: "contract-subscription-oversight",
    name: "Track contracts, subscriptions, and renewal decisions",
    description:
      "Creates one governed agreement register, renewal notice, accountable owner, obligation tracking, remaining-value view, and invoice-to-contract reconciliation.",
    ownerOrganizationKey: "procurement-services",
    capabilities: [
      "agreement register",
      "renewal notice",
      "accountable owner",
      "obligation tracking",
      "remaining contract value",
      "invoice reconciliation",
    ],
    prerequisites: [
      "Agreement documents",
      "Finance and procurement identifiers",
      "Named contract owner",
    ],
    reviewDate: "2027-04-30",
  },
] satisfies SeedServiceOffering[];
