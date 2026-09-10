import type { RequestStage } from "../domain/constants.ts";

export interface AdditionalRequest {
  key: string;
  title: string;
  problem: string;
  affectedPeople: string;
  acceptanceCriteria: string[];
  requirements: string[];
  constraints: string[];
  unknowns: string[];
  requesterActorKey: string;
  organizationKey: string;
  serviceOfferingKey: string | null;
  assetKeys: string[];
  policyCodes: string[];
  stage: RequestStage;
}

export const additionalRequests = [
  {
    key: "environmental-complaint-field-evidence",
    title: "Capture environmental complaint evidence in the field",
    problem:
      "Investigators photograph complaint sites on personal phones, write coordinates on paper, and later re-enter the same facts into the case record.",
    affectedPeople:
      "Fourteen environmental investigators and three supervisors across five districts",
    acceptanceCriteria: [
      "An investigator records the site, photographs, notes, and location once while offline",
      "The complete visit appears in the complaint record within one hour of reconnection",
    ],
    requirements: [
      "Offline field form",
      "Photograph and location capture",
      "Connection to the complaint case",
      "Supervisor visibility into failed synchronization",
    ],
    constraints: [
      "Many sites have no cellular coverage",
      "Photographs may contain private property and personal information",
    ],
    unknowns: ["The complaint system integration method is not documented"],
    requesterActorKey: "tobias-vance",
    organizationKey: "environmental-quality",
    serviceOfferingKey: "mobile-field-inspection",
    assetKeys: ["fieldmark-mobile", "case-atlas"],
    policyCodes: ["SEC-03", "PRV-01"],
    stage: "under_review",
  },
  {
    key: "grant-closeout-evidence",
    title: "Reconcile grant closeout evidence before releasing final payment",
    problem:
      "Program staff keep closeout reports and expenditure evidence in separate drives, so finance cannot tell whether every obligation is complete before final payment.",
    affectedPeople:
      "Seven grant managers, twelve finance reviewers, and roughly eighty subrecipients",
    acceptanceCriteria: [
      "Every closeout requirement has an owner and completion state",
      "Finance can trace final payment approval to accepted program evidence",
    ],
    requirements: [
      "Closeout checklist by award type",
      "Evidence attachment and review",
      "Exception rationale",
      "Payment approval history",
    ],
    constraints: ["Award documents must remain available for seven years"],
    unknowns: [],
    requesterActorKey: "leila-morgan",
    organizationKey: "state-comptroller",
    serviceOfferingKey: "grants-program-administration",
    assetKeys: ["grants-conductor", "ledger-core"],
    policyCodes: ["POL-02", "SEC-04"],
    stage: "first_review_completed",
  },
  {
    key: "translate-benefit-renewal-notice",
    title: "Translate benefit renewal notices before the annual mailing",
    problem:
      "The renewal notice exists only in English, and program staff have no controlled translation and approval path for the six languages required this year.",
    affectedPeople:
      "About thirty-five thousand households receiving a renewal notice",
    acceptanceCriteria: [
      "Approved notices are available in all six required languages",
      "Each published notice retains its translator, reviewer, and source version",
    ],
    requirements: [
      "Plain-language source review",
      "Qualified translation approval",
      "Accessible document output",
      "Version and publication history",
    ],
    constraints: ["Mail files must be final six weeks before renewal opens"],
    unknowns: ["Two language reviewers have not yet been assigned"],
    requesterActorKey: "avery-brooks",
    organizationKey: "community-health",
    serviceOfferingKey: "language-access-remediation",
    assetKeys: ["translate-bridge", "accessibility-inspector"],
    policyCodes: ["ACC-02", "ACC-03", "PRV-01"],
    stage: "under_review",
  },
  {
    key: "quarterly-service-feedback",
    title: "Replace quarterly service-feedback spreadsheets",
    problem:
      "Six program teams export survey responses into separate spreadsheets and manually rebuild a statewide satisfaction figure every quarter.",
    affectedPeople:
      "Six program managers and the leadership team that reviews service performance",
    acceptanceCriteria: [
      "Each program can see its live satisfaction result without rebuilding a spreadsheet",
      "Seeded and test responses never enter the published live denominator",
    ],
    requirements: [
      "One five-point measure tied to task completion",
      "Program and channel breakdown",
      "Duplicate-response prevention",
      "Quarter-over-quarter trend",
    ],
    constraints: ["No narrative response is required for the first release"],
    unknowns: [],
    requesterActorKey: "nadia-brant",
    organizationKey: "constituent-services",
    serviceOfferingKey: "service-feedback-measurement",
    assetKeys: ["survey-signal", "insight-canvas"],
    policyCodes: ["PRV-02", "POL-02"],
    stage: "first_review_completed",
  },
  {
    key: "seasonal-worker-access",
    title: "Remove seasonal-worker access when assignments end",
    problem:
      "Seasonal workers keep application access after their assignments end because each system receives a spreadsheet and removes accounts on a different schedule.",
    affectedPeople:
      "About nine hundred seasonal workers, forty supervisors, and three access administrators",
    acceptanceCriteria: [
      "Access ends within four hours of an assignment end date",
      "An auditor can trace every retained exception to an approver and expiration",
    ],
    requirements: [
      "Authoritative assignment-end event",
      "Automated entitlement removal",
      "Time-bound exception approval",
      "Access evidence by system",
    ],
    constraints: ["Several applications are owned by partner agencies"],
    unknowns: ["Two partner systems do not publish an automated interface"],
    requesterActorKey: "priya-raman",
    organizationKey: "labor-employment",
    serviceOfferingKey: "identity-access-governance",
    assetKeys: ["access-steward", "people-roster", "identity-gateway"],
    policyCodes: ["SEC-01", "POL-02"],
    stage: "under_review",
  },
  {
    key: "public-records-legal-hold",
    title: "Apply one legal hold across records held by three offices",
    problem:
      "Counsel sends legal-hold instructions by email, and each office tracks affected records differently, leaving no complete proof that disposal stopped everywhere.",
    affectedPeople:
      "Counsel, nine records custodians, and staff in three program offices",
    acceptanceCriteria: [
      "Counsel can see every custodian acknowledgment and affected record series",
      "Normal disposal remains suspended until counsel releases the hold",
    ],
    requirements: [
      "Central hold instruction",
      "Custodian acknowledgment",
      "Record-series coverage",
      "Release and resumption history",
    ],
    constraints: ["Source records remain in their existing repositories"],
    unknowns: [],
    requesterActorKey: "marcus-oyelaran",
    organizationKey: "state-archivist",
    serviceOfferingKey: "records-disclosure-management",
    assetKeys: ["records-vault", "docmesh-repository"],
    policyCodes: ["POL-02", "SEC-04"],
    stage: "submitted",
  },
  {
    key: "vendor-api-data-exchange",
    title: "Exchange licensing status with an outside credentialing partner",
    problem:
      "Staff download a licensing-status file each week and email it to a partner, then import the partner response by hand without a reliable reconciliation report.",
    affectedPeople: "Six licensing staff and two partner organizations",
    acceptanceCriteria: [
      "Approved status changes cross the boundary without emailed files",
      "Every rejected or unmatched record appears in a reconciliation report",
    ],
    requirements: [
      "Authenticated system connection",
      "Schema and validation agreement",
      "Retry and exception handling",
      "Transmission and reconciliation evidence",
    ],
    constraints: [
      "The partner controls its interface",
      "The exchange contains confidential license-holder information",
    ],
    unknowns: ["The partner has not supplied its final interface contract"],
    requesterActorKey: "malik-thompson",
    organizationKey: "workforce-services",
    serviceOfferingKey: null,
    assetKeys: ["api-junction", "event-relay-bus"],
    policyCodes: ["SEC-03", "POL-01", "PRV-01"],
    stage: "submitted",
  },
  {
    key: "contract-owner-transfer",
    title: "Transfer contract ownership when a budget sponsor leaves",
    problem:
      "Renewal notices continue going to former employees because contract ownership is stored in documents and does not change when a sponsor leaves the agency.",
    affectedPeople:
      "Sixty budget sponsors, six contract officers, and vendor-management staff",
    acceptanceCriteria: [
      "Every active agreement has a current accountable owner",
      "Ownership transfers before the former sponsor account closes",
    ],
    requirements: [
      "Agreement-to-owner relationship",
      "Workforce departure event",
      "Successor assignment",
      "Transfer and exception history",
    ],
    constraints: ["Some agreements name an individual in signed terms"],
    unknowns: [],
    requesterActorKey: "leila-morgan",
    organizationKey: "state-comptroller",
    serviceOfferingKey: "contract-subscription-oversight",
    assetKeys: ["contract-sentinel", "people-roster"],
    policyCodes: ["POL-01", "PRC-03"],
    stage: "under_review",
  },
  {
    key: "inspection-route-rebalance",
    title: "Rebalance inspection routes when urgent visits arrive",
    problem:
      "Supervisors publish routes each morning, but an urgent visit forces them to call every inspector and rebuild the remaining day on paper.",
    affectedPeople: "Twenty-two inspectors and four district supervisors",
    acceptanceCriteria: [
      "An urgent visit is assigned without discarding completed stops",
      "Every affected inspector receives the revised route within five minutes",
    ],
    requirements: [
      "Current location and remaining stops",
      "Inspector skill and territory constraints",
      "Midday route recalculation",
      "Delivery acknowledgment",
    ],
    constraints: ["Inspectors may be offline between stops"],
    unknowns: [],
    requesterActorKey: "tobias-vance",
    organizationKey: "environmental-quality",
    serviceOfferingKey: "mobile-field-inspection",
    assetKeys: ["route-planner-pro", "fieldmark-mobile"],
    policyCodes: ["SEC-03"],
    stage: "first_review_completed",
  },
  {
    key: "cloud-release-rollback",
    title: "Make the public portal release reproducible and reversible",
    problem:
      "The public portal is copied to production from a developer workstation, so the team cannot prove what changed or restore the previous release after a failed deployment.",
    affectedPeople:
      "Five portal developers, the production support team, and residents using the portal",
    acceptanceCriteria: [
      "Every release is built from reviewed source and a signed immutable artifact",
      "Operations can restore the previous release within fifteen minutes",
    ],
    requirements: [
      "Managed repository",
      "Automated build and security scan",
      "Signed container image",
      "Release approval and history",
      "Rollback procedure",
    ],
    constraints: ["The portal must remain available during business hours"],
    unknowns: ["The current hosting boundary has not been documented"],
    requesterActorKey: "nadia-brant",
    organizationKey: "constituent-services",
    serviceOfferingKey: "delivery-pipeline-enablement",
    assetKeys: [
      "azure-devops-delivery-platform",
      "state-container-registry",
      "vuln-scout",
    ],
    policyCodes: ["SEC-02", "SEC-06", "POL-01"],
    stage: "under_review",
  },
  {
    key: "archived-board-packets",
    title: "Publish accessible board packets with a permanent record",
    problem:
      "Board packets are assembled from email attachments, published without a consistent accessibility check, and later stored without a reliable link to the version the public received.",
    affectedPeople:
      "Two board coordinators, twelve board members, and members of the public",
    acceptanceCriteria: [
      "Every published packet passes the required accessibility review",
      "The archived record identifies the exact packet and publication time",
    ],
    requirements: [
      "Controlled packet assembly",
      "Accessible document check",
      "Publication approval",
      "Permanent record and version link",
    ],
    constraints: ["Packets must publish five days before each meeting"],
    unknowns: [],
    requesterActorKey: "marcus-oyelaran",
    organizationKey: "state-archivist",
    serviceOfferingKey: "content-governance",
    assetKeys: [
      "docmesh-repository",
      "accessibility-inspector",
      "archive-keeper",
    ],
    policyCodes: ["ACC-01", "ACC-03", "POL-02"],
    stage: "submitted",
  },
  {
    key: "laboratory-sample-chain-of-custody",
    title: "Replace the paper chain of custody for laboratory samples",
    problem:
      "Field teams hand laboratory samples between couriers and analysts using carbon-copy paper forms, so the program cannot prove who held a sample during an unexplained delay.",
    affectedPeople:
      "Twelve field collectors, four couriers, nine laboratory analysts, and two quality managers",
    acceptanceCriteria: [
      "Every transfer records the sample, sender, recipient, time, and condition",
      "A quality manager can reconstruct the complete chain without locating paper forms",
    ],
    requirements: [
      "Tamper-evident sample identifier",
      "Offline transfer acknowledgment",
      "Condition and exception record",
      "Complete custody timeline",
    ],
    constraints: [
      "Collectors often work without connectivity",
      "The laboratory system cannot be changed this year",
    ],
    unknowns: [
      "No approved product has been identified for physical sample custody",
    ],
    requesterActorKey: "tobias-vance",
    organizationKey: "environmental-quality",
    serviceOfferingKey: null,
    assetKeys: [],
    policyCodes: ["POL-02", "SEC-03"],
    stage: "submitted",
  },
] satisfies AdditionalRequest[];
