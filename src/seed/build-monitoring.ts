import { daysBefore, minutesBefore, stableUuid } from "./stable.ts";
import type { SeedData } from "./types.ts";
import { seedWorkItems } from "./work-items.ts";

export type MonitoringData = Pick<
  SeedData,
  "workSystems" | "workSyncRuns" | "externalWorkItems" | "requestWorkItemLinks"
>;

export function buildMonitoring(
  requests: SeedData["requests"],
  referenceTime: string,
): MonitoringData {
  const externalWorkItems = seedWorkItems.map((item) =>
    externalItem(item, referenceTime),
  );
  const requestIds = new Map(
    requests.map((request) => [
      request.fixtureKey?.replace("request:", "") ?? "",
      request.id,
    ]),
  );
  return {
    workSystems: systems(referenceTime),
    workSyncRuns: syncRuns(referenceTime),
    externalWorkItems,
    requestWorkItemLinks: seedWorkItems.flatMap((item) =>
      item.requestKeys.map((requestKey) => ({
        requestId: required(requestIds, requestKey, "work item request"),
        workItemId: stableUuid("external-work-item", item.key),
        relationship: "delivery_work",
        fixtureKey: "request-work-item-link:" + requestKey + ":" + item.key,
      })),
    ),
  };
}

function systems(referenceTime: string): SeedData["workSystems"] {
  return [
    {
      system: "servicenow",
      fixtureKey: "work-system:servicenow",
      name: "ServiceNow",
      authoritativeBaseUrl: "https://servicenow.example.invalid",
      expectedFreshnessHours: 24,
      lastSuccessfulAt: daysBefore(referenceTime, 2),
      syncHealth: "failed",
    },
    {
      system: "azure_devops",
      fixtureKey: "work-system:azure-devops",
      name: "Azure DevOps",
      authoritativeBaseUrl: "https://dev.azure.example.invalid",
      expectedFreshnessHours: 24,
      lastSuccessfulAt: minutesBefore(referenceTime, 60),
      syncHealth: "current",
    },
  ];
}

function syncRuns(referenceTime: string): SeedData["workSyncRuns"] {
  return [
    {
      id: stableUuid("work-sync-run", "servicenow-success"),
      fixtureKey: "work-sync-run:servicenow-success",
      system: "servicenow",
      status: "succeeded",
      itemCount: countItems("servicenow"),
      sanitizedError: null,
      startedAt: daysBefore(referenceTime, 2),
      completedAt: daysBefore(referenceTime, 2),
    },
    {
      id: stableUuid("work-sync-run", "servicenow-failed"),
      fixtureKey: "work-sync-run:servicenow-failed",
      system: "servicenow",
      status: "failed",
      itemCount: 0,
      sanitizedError: "The fixture service was unavailable.",
      startedAt: minutesBefore(referenceTime, 15),
      completedAt: minutesBefore(referenceTime, 14),
    },
    {
      id: stableUuid("work-sync-run", "azure-devops-success"),
      fixtureKey: "work-sync-run:azure-devops-success",
      system: "azure_devops",
      status: "succeeded",
      itemCount: countItems("azure_devops"),
      sanitizedError: null,
      startedAt: minutesBefore(referenceTime, 60),
      completedAt: minutesBefore(referenceTime, 59),
    },
  ];
}

function externalItem(
  item: (typeof seedWorkItems)[number],
  referenceTime: string,
): SeedData["externalWorkItems"][number] {
  const baseUrl =
    item.system === "servicenow"
      ? "https://servicenow.example.invalid/"
      : "https://dev.azure.example.invalid/";
  const synchronizedAt =
    item.system === "servicenow"
      ? daysBefore(referenceTime, 2)
      : minutesBefore(referenceTime, 59);
  return {
    id: stableUuid("external-work-item", item.key),
    fixtureKey: "external-work-item:" + item.key,
    system: item.system,
    externalId: item.externalId,
    title: item.title,
    sourceStatus: item.sourceStatus,
    sourceOwner: item.sourceOwner,
    sourceUrl: baseUrl + item.externalId,
    sourceUpdatedAt: daysBefore(referenceTime, item.sourceUpdatedDaysAgo),
    lastSynchronizedAt: synchronizedAt,
    syncHealth: item.syncHealth,
  };
}

function countItems(system: "servicenow" | "azure_devops"): number {
  return seedWorkItems.filter((item) => item.system === system).length;
}

function required<K, V>(values: Map<K, V>, key: K, label: string): V {
  const value = values.get(key);
  if (value === undefined) throw new Error("Missing " + label + ": " + key);
  return value;
}
