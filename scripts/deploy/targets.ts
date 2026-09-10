const targets = {
  personal: {
    account_id: "845191826742",
    region: "us-west-2",
    name: "one-door-personal",
    app_origin: null,
    github_owner: "rswerve",
    github_owner_id: "8964335",
    github_repository: "one-door",
    github_repository_id: "1354631764",
  },
  truss: {
    account_id: "004351505091",
    region: "us-west-2",
    name: "one-door-truss",
    app_origin: "https://one-door.sandbox.truss.coffee",
    github_owner: "trussworks",
    github_owner_id: "1649505",
    github_repository: "one-door",
    github_repository_id: "1362084625",
  },
} as const;

export function deploymentTarget(environment: string) {
  if (environment !== "personal" && environment !== "truss")
    throw new Error("Unknown deployment environment: " + environment);
  return targets[environment];
}

export function githubSubject(environment: string, publisher = false): string {
  const target = deploymentTarget(environment);
  const context = publisher ? environment + "-publish" : environment;
  return `repo:${target.github_owner}@${target.github_owner_id}/${target.github_repository}@${target.github_repository_id}:environment:${context}`;
}

export function deploymentEnvironment(account: string): "personal" | "truss" {
  for (const environment of ["personal", "truss"] as const)
    if (targets[environment].account_id === account) return environment;
  throw new Error("Unknown deployment account: " + account);
}
