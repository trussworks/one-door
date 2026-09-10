export interface SeedOrganization {
  key: string;
  name: string;
  kind: "agency" | "office" | "team";
  parentKey: string | null;
}

export const seedOrganizations = [
  {
    key: "colorado",
    name: "State of Colorado",
    kind: "agency",
    parentKey: null,
  },
  {
    key: "oit",
    name: "Office of Information Technology",
    kind: "agency",
    parentKey: "colorado",
  },
  {
    key: "constituent-services",
    name: "Office of Constituent Services",
    kind: "office",
    parentKey: "colorado",
  },
  {
    key: "state-archivist",
    name: "Office of the State Archivist",
    kind: "office",
    parentKey: "colorado",
  },
  {
    key: "environmental-quality",
    name: "Division of Environmental Quality",
    kind: "office",
    parentKey: "colorado",
  },
  {
    key: "workforce-services",
    name: "Department of Workforce Services",
    kind: "agency",
    parentKey: "colorado",
  },
  {
    key: "state-comptroller",
    name: "Office of the State Comptroller",
    kind: "office",
    parentKey: "colorado",
  },
  {
    key: "community-health",
    name: "Department of Community Health",
    kind: "agency",
    parentKey: "colorado",
  },
  {
    key: "enterprise-security",
    name: "Office of Enterprise Security",
    kind: "office",
    parentKey: "oit",
  },
  {
    key: "procurement-services",
    name: "Division of Procurement Services",
    kind: "office",
    parentKey: "colorado",
  },
  {
    key: "human-resources",
    name: "Division of Human Resources",
    kind: "office",
    parentKey: "colorado",
  },
  {
    key: "ospb",
    name: "Office of State Planning and Budgeting",
    kind: "agency",
    parentKey: "colorado",
  },
  {
    key: "budget-office",
    name: "Budget Office",
    kind: "office",
    parentKey: "ospb",
  },
  {
    key: "labor-employment",
    name: "Department of Labor and Employment",
    kind: "agency",
    parentKey: "colorado",
  },
  {
    key: "natural-resources",
    name: "Department of Natural Resources",
    kind: "agency",
    parentKey: "colorado",
  },
  {
    key: "revenue",
    name: "Department of Revenue",
    kind: "agency",
    parentKey: "colorado",
  },
  {
    key: "personnel",
    name: "Department of Personnel",
    kind: "agency",
    parentKey: "colorado",
  },
  {
    key: "configuration-management",
    name: "Configuration Management",
    kind: "team",
    parentKey: "oit",
  },
  {
    key: "enterprise-architecture",
    name: "Enterprise Architecture",
    kind: "team",
    parentKey: "oit",
  },
  {
    key: "vendor-management",
    name: "Vendor Management",
    kind: "team",
    parentKey: "oit",
  },
  {
    key: "cloud-platform",
    name: "Cloud Platform",
    kind: "team",
    parentKey: "oit",
  },
  {
    key: "platform-enablement",
    name: "Platform Enablement",
    kind: "team",
    parentKey: "oit",
  },
  {
    key: "shared-services",
    name: "Shared Services",
    kind: "team",
    parentKey: "oit",
  },
] satisfies SeedOrganization[];
