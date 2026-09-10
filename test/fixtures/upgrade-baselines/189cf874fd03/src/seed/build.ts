import { seedActors } from "./actors.ts";
import { buildInventory } from "./build-inventory.ts";
import { buildMonitoring } from "./build-monitoring.ts";
import { buildRequests } from "./build-requests.ts";
import { catalogItems as catalogSources } from "./catalog.ts";
import { seedOrganizations } from "./organizations.ts";
import { policyRules as policySources } from "./policies.ts";
import { seedServiceOfferings } from "./service-offerings.ts";
import { contentHash, daysBefore, SEED_NOW, stableUuid } from "./stable.ts";
import type { SeedData } from "./types.ts";

type OrganizationRow = SeedData["organizations"][number];
type ActorRow = SeedData["actors"][number];
type OfferingRow = SeedData["serviceOfferings"][number];
type CatalogRow = SeedData["catalogItems"][number];
type PolicyRow = SeedData["policyRules"][number];

export function buildSeedData(referenceTime = SEED_NOW): SeedData {
  const organizations = buildOrganizations(referenceTime);
  const organizationIds = fixtureKeyMap(organizations);
  const actors = buildActors(organizationIds, referenceTime);
  const actorIds = fixtureKeyMap(actors);
  const serviceOfferings = buildServiceOfferings(
    organizationIds,
    referenceTime,
  );
  const catalogItems = buildCatalog(organizationIds, referenceTime);
  const policyRules = buildPolicies(referenceTime);
  const inventory = buildInventory(
    catalogItems,
    organizationIds,
    actorIds,
    referenceTime,
  );
  const requestData = buildRequests({
    actorIds,
    organizationIds,
    offeringIds: new Map(
      serviceOfferings.map((row) => [row.offeringKey, row.id]),
    ),
    catalogIds: new Map(catalogItems.map((row) => [row.itemKey, row.id])),
    policyIds: new Map(policyRules.map((row) => [row.code, row.id])),
    policyRules,
    catalogItems,
    referenceTime,
  });
  return {
    organizations,
    actors,
    visitors: [],
    wip: [],
    serviceOfferings,
    catalogItems,
    policyRules,
    ...inventory,
    ...requestData,
    ...buildMonitoring(requestData.requests, referenceTime),
  };
}

function buildOrganizations(referenceTime: string): OrganizationRow[] {
  const ids = new Map(
    seedOrganizations.map((organization) => [
      organization.key,
      stableUuid("organization", organization.key),
    ]),
  );
  return seedOrganizations.map((organization) => ({
    id: required(ids, organization.key, "organization"),
    fixtureKey: "organization:" + organization.key,
    name: organization.name,
    kind: organization.kind,
    parentId: organization.parentKey
      ? required(ids, organization.parentKey, "parent organization")
      : null,
    active: true,
    createdAt: daysBefore(referenceTime, 120),
    updatedAt: daysBefore(referenceTime, 30),
  }));
}

function buildActors(
  organizationIds: Map<string, string>,
  referenceTime: string,
): ActorRow[] {
  return seedActors.map((actor) => ({
    id: stableUuid("actor", actor.key),
    fixtureKey: "actor:" + actor.key,
    kind: actor.kind,
    displayName: actor.displayName,
    email: actor.email,
    organizationId: actor.organizationKey
      ? required(organizationIds, actor.organizationKey, "actor organization")
      : null,
    capabilities: actor.capabilities,
    active: true,
    createdAt: daysBefore(referenceTime, 120),
    updatedAt: daysBefore(referenceTime, 30),
  }));
}

function buildServiceOfferings(
  organizationIds: Map<string, string>,
  referenceTime: string,
): OfferingRow[] {
  return seedServiceOfferings.map((offering) => ({
    id: stableUuid("service-offering", offering.key + ":1"),
    fixtureKey: "service-offering:" + offering.key + ":1",
    offeringKey: offering.key,
    version: 1,
    supersedesId: null,
    lifecycle: "active",
    name: offering.name,
    description: offering.description,
    ownerOrganizationId: required(
      organizationIds,
      offering.ownerOrganizationKey,
      "service owner",
    ),
    capabilities: offering.capabilities,
    prerequisites: offering.prerequisites,
    reviewDate: offering.reviewDate,
    contentHash: contentHash(offering),
    createdAt: daysBefore(referenceTime, 90),
  }));
}

function buildCatalog(
  organizationIds: Map<string, string>,
  referenceTime: string,
): CatalogRow[] {
  const organizationsByName = new Map(
    seedOrganizations.map((organization) => [
      organization.name,
      organization.key,
    ]),
  );
  return catalogSources.map((item) => {
    const ownerKey = required(
      organizationsByName,
      item.ownerOffice,
      "catalog owner name",
    );
    return {
      id: stableUuid("catalog-item", item.key),
      fixtureKey: "catalog-item:" + item.key,
      itemKey: item.key,
      publicationState: publicationState(item.approvalStatus),
      approvalStatus: approvalState(item.approvalStatus),
      itemType: itemType(item.key),
      currentVersion: 1,
      name: item.name,
      vendor: item.vendor,
      description: item.description,
      capabilities: item.capabilities,
      ownerOrganizationId: required(organizationIds, ownerKey, "catalog owner"),
      licenseModel: item.licenseModel,
      dataClassifications: item.dataTypes,
      integrations: item.integrations,
      reviewDate: item.renewalDate ?? "2027-06-30",
      renewalDate: item.renewalDate,
      rowVersion: 1,
      createdAt: daysBefore(referenceTime, 90),
      updatedAt: daysBefore(referenceTime, 14),
    };
  });
}

function buildPolicies(referenceTime: string): PolicyRow[] {
  return policySources.map((rule) => ({
    id: stableUuid("policy-rule", rule.code + ":1"),
    fixtureKey: "policy-rule:" + rule.code + ":1",
    code: rule.code,
    version: 1,
    supersedesId: null,
    lifecycle: "active",
    domain: rule.domain,
    title: rule.title,
    rule: rule.rule,
    triggerTerms: rule.triggerTerms,
    defaultSeverity: rule.defaultSeverity,
    citation: rule.citation,
    contentHash: contentHash(rule),
    createdAt: daysBefore(referenceTime, 90),
  }));
}

function publicationState(
  source: "approved" | "pilot" | "retiring",
): "published" | "retired" {
  return source === "retiring" ? "retired" : "published";
}

function approvalState(
  source: "approved" | "pilot" | "retiring",
): "approved" | "conditional" | "review_required" {
  if (source === "approved") return "approved";
  if (source === "pilot") return "conditional";
  return "review_required";
}

function itemType(key: string): "software" | "infrastructure" | "platform" {
  if (["asset-registry", "colorado-azure-landing-zone"].includes(key))
    return "infrastructure";
  if (
    [
      "servicedesk-central",
      "identity-gateway",
      "credential-vault",
      "datalake-foundry",
      "metric-warden",
      "terra-map-server",
      "api-junction",
      "event-relay-bus",
      "sync-forge",
      "azure-devops-delivery-platform",
      "application-observability-service",
      "state-container-registry",
      "state-messaging-gateway",
    ].includes(key)
  )
    return "platform";
  return "software";
}

function fixtureKeyMap<T extends { id: string; fixtureKey?: string | null }>(
  rows: T[],
): Map<string, string> {
  return new Map(
    rows.map((row) => {
      if (!row.fixtureKey) throw new Error("Fixture key is missing");
      return [row.fixtureKey.slice(row.fixtureKey.indexOf(":") + 1), row.id];
    }),
  );
}

function required<K, V>(values: Map<K, V>, key: K, label: string): V {
  const value = values.get(key);
  if (value === undefined) throw new Error("Missing " + label + ": " + key);
  return value;
}
