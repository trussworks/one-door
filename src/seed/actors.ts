import { createHash } from "node:crypto";

export interface SeedActor {
  key: string;
  displayName: string;
  email: string | null;
  organizationKey: string | null;
  kind: "persona" | "system";
  capabilities: string[];
}

export const seedActors = [
  {
    key: "nadia-brant",
    displayName: "Nadia Brant",
    email: "nadia.brant@example.com",
    organizationKey: "constituent-services",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "tobias-vance",
    displayName: "Tobias Vance",
    email: "tobias.vance@example.com",
    organizationKey: "environmental-quality",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "priya-raman",
    displayName: "Priya Raman",
    email: "priya.raman@example.com",
    organizationKey: "labor-employment",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "marcus-oyelaran",
    displayName: "Marcus Oyelaran",
    email: "marcus.oyelaran@example.com",
    organizationKey: "state-archivist",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "avery-brooks",
    displayName: "Avery Brooks",
    email: "avery.brooks@example.com",
    organizationKey: "community-health",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "samira-holt",
    displayName: "Samira Holt",
    email: "samira.holt@example.com",
    organizationKey: "budget-office",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "leila-morgan",
    displayName: "Leila Morgan",
    email: "leila.morgan@example.com",
    organizationKey: "state-comptroller",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "rowan-kim",
    displayName: "Rowan Kim",
    email: "rowan.kim@example.com",
    organizationKey: "natural-resources",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "malik-thompson",
    displayName: "Malik Thompson",
    email: "malik.thompson@example.com",
    organizationKey: "workforce-services",
    kind: "persona",
    capabilities: ["request_services"],
  },
  {
    key: "elena-castellanos",
    displayName: "Elena Castellanos",
    email: "elena.castellanos@example.com",
    organizationKey: "oit",
    kind: "persona",
    capabilities: [
      "coordinate_first_review",
      "review_existing_assets",
      "assign_work",
    ],
  },
  {
    key: "jordan-lee",
    displayName: "Jordan Lee",
    email: "jordan.lee@example.com",
    organizationKey: "enterprise-security",
    kind: "persona",
    capabilities: ["review_risk", "score_reach_impact_confidence"],
  },
  {
    key: "maya-chen",
    displayName: "Maya Chen",
    email: "maya.chen@example.com",
    organizationKey: "enterprise-architecture",
    kind: "persona",
    capabilities: ["steward_catalog", "publish_canonical_assets"],
  },
  {
    key: "arjun-patel",
    displayName: "Arjun Patel",
    email: "arjun.patel@example.com",
    organizationKey: "oit",
    kind: "persona",
    capabilities: ["own_service", "route_unmatched_requests"],
  },
  {
    key: "devon-okafor",
    displayName: "Devon Okafor",
    email: "devon.okafor@example.com",
    organizationKey: "platform-enablement",
    kind: "persona",
    capabilities: ["estimate_delivery_effort", "plan_delivery"],
  },
  {
    key: "june-halloway",
    displayName: "June Halloway",
    email: "june.halloway@example.com",
    organizationKey: "oit",
    kind: "persona",
    capabilities: ["coordinate_first_review", "monitor_delivery"],
  },
  {
    key: "desmond-arkwright",
    displayName: "Desmond Arkwright",
    email: "desmond.arkwright@example.com",
    organizationKey: "oit",
    kind: "persona",
    capabilities: ["score_reach_impact_confidence", "compare_priorities"],
  },
  {
    key: "saoirse-lindqvist",
    displayName: "Saoirse Lindqvist",
    email: "saoirse.lindqvist@example.com",
    organizationKey: "procurement-services",
    kind: "persona",
    capabilities: ["route_procurement", "review_existing_assets"],
  },
  {
    key: "one-door-system",
    displayName: "One Door",
    email: null,
    organizationKey: "oit",
    kind: "system",
    capabilities: ["prepare_model_proposals", "record_system_activity"],
  },
] satisfies SeedActor[];

/**
 * The seeded reviewer a demo visitor acts as. Must equal the persona the read
 * model scopes "My assignments" to; a test holds the two together.
 */
export const demoCoordinatorKey = "elena-castellanos";

/**
 * The people a seeded request may be coordinated by: everyone the fixture
 * gives the first-review coordination capability. The pool is derived rather
 * than listed, so a capability change moves the roster with it instead of
 * leaving a stale name behind.
 */
export const reviewCoordinatorKeys = seedActors
  .filter((actor) => actor.capabilities.includes("coordinate_first_review"))
  .map((actor) => actor.key);

const otherCoordinatorKeys = reviewCoordinatorKeys.filter(
  (key) => key !== demoCoordinatorKey,
);

/**
 * Picks a coordinator from a request's own key, so the same request always
 * draws the same person whatever order the seed builds in and the fixture hash
 * stays stable. Roughly one example in three goes to another qualified
 * coordinator, which shows a shared queue while leaving the demo persona
 * enough work for "My assignments" to mean something.
 */
export function reviewCoordinatorKeyFor(requestKey: string): string {
  if (otherCoordinatorKeys.length === 0) return demoCoordinatorKey;
  const digest = parseInt(
    createHash("sha256").update(requestKey).digest("hex").slice(0, 8),
    16,
  );
  if (digest % 3 !== 0) return demoCoordinatorKey;
  return otherCoordinatorKeys[digest % otherCoordinatorKeys.length]!;
}
