// Pin object IDs before scanning so concurrent recording cannot change the upload.
import { isMain } from "./is-main.mjs";
import { git, scanRevisions, type Finding } from "./scan-secrets.ts";

interface Checkpoint {
  ref: string;
  oid: string;
}

export function pinCheckpoints(): Checkpoint[] {
  const lines = git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/entire/checkpoints",
  ])
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => {
    const [ref, oid] = line.split(" ");
    return { ref, oid };
  });
}

function remoteCheckpointOids(remote: string): string[] {
  let output: string;
  try {
    output = git(["ls-remote", remote, "refs/entire/checkpoints/*"]);
  } catch {
    return [];
  }
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[0]);
}

// An unknown object cannot safely narrow the scan.
function present(oid: string): boolean {
  try {
    git(["cat-file", "-e", `${oid}^{object}`]);
    return true;
  } catch {
    return false;
  }
}

// Only this destination's confirmed objects can be excluded, never another remote's.
export function scanCheckpoints(
  pinned: Checkpoint[],
  exclude: string[],
): Finding[] {
  if (pinned.length === 0) return [];
  return scanRevisions([
    ...pinned.map((entry) => entry.oid),
    "--not",
    ...exclude.filter(present),
  ]);
}

function publish(remote: string, pinned: Checkpoint[]): number {
  if (pinned.length === 0) {
    console.log("No checkpoints to publish.");
    return 0;
  }
  git(["push", remote, ...pinned.map((entry) => `${entry.oid}:${entry.ref}`)]);
  const published = new Map<string, string>();
  for (const line of git(["ls-remote", remote, "refs/entire/checkpoints/*"])
    .split("\n")
    .filter(Boolean)) {
    const [oid, ref] = line.split("\t");
    published.set(ref, oid);
  }
  const missing = pinned.filter(
    (entry) => published.get(entry.ref) !== entry.oid,
  );
  if (missing.length > 0) {
    console.error("Checkpoints did not land on the remote:");
    for (const entry of missing) console.error(`  ${entry.ref}`);
    return 1;
  }
  console.log(`Published ${pinned.length} checkpoint(s).`);
  return 0;
}

function main(argv: string[]): number {
  const remote = argv[0] ?? "origin";
  const pinned = pinCheckpoints();
  const findings = scanCheckpoints(pinned, remoteCheckpointOids(remote));
  if (findings.length > 0) {
    console.error("Checkpoint publication refused; values are not printed:");
    for (const finding of findings)
      console.error(`  ${finding.path}:${finding.line}  ${finding.rule}`);
    return 1;
  }
  return publish(remote, pinned);
}

if (isMain(import.meta)) process.exit(main(process.argv.slice(2)));
