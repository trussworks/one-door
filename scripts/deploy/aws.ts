import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { deploymentTarget } from "./targets.ts";

export class AwsError extends Error {
  // An explicit field, not a constructor parameter property: Node's
  // strip-only TypeScript mode rejects parameter properties, and these
  // scripts run under `node --experimental-strip-types`.
  readonly code: string;
  constructor(code: string, operation: string) {
    super(`${operation} failed (${code})`);
    this.code = code;
  }
}

/**
 * Deployment tools are resolved from absolute paths, never from PATH, so a
 * writable directory earlier in PATH cannot substitute a binary that handles
 * credentials. ONE_DOOR_<TOOL> overrides for a non-standard install.
 */
export function resolveTool(
  name: "aws" | "docker" | "security" | "terraform",
  candidates: string[] = {
    aws: ["/opt/homebrew/bin/aws", "/usr/local/bin/aws", "/usr/bin/aws"],
    docker: [
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/usr/bin/docker",
    ],
    security: ["/usr/bin/security"],
    terraform: [
      "/opt/homebrew/bin/terraform",
      "/usr/local/bin/terraform",
      "/usr/bin/terraform",
    ],
  }[name],
): string {
  const override = process.env["ONE_DOOR_" + name.toUpperCase()];
  if (override) {
    if (!isAbsolute(override))
      throw new Error(
        `ONE_DOOR_${name.toUpperCase()} must be an absolute path`,
      );
    return override;
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `${name} was not found at a known absolute path; set ONE_DOOR_${name.toUpperCase()}`,
  );
}

export function aws<T = Record<string, unknown>>(
  args: string[],
  input?: string,
): T {
  try {
    const executable = resolveTool("aws");
    const cliArgs = [...args, "--output", "json", "--no-cli-pager"];
    // Node uses a socket for piped stdin on macOS; AWS cannot reopen that
    // socket through /dev/stdin. cat supplies a real pipe without putting
    // secret values in arguments or temporary files.
    const output = execFileSync(
      input === undefined ? executable : "/bin/bash",
      input === undefined
        ? cliArgs
        : [
            "-o",
            "pipefail",
            "-c",
            '/bin/cat | "$@"',
            "aws-stdin",
            executable,
            ...cliArgs,
          ],
      {
        input,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
      },
    ).trim();
    return output ? (JSON.parse(output) as T) : ({} as T);
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    const code =
      stderr.match(/An error occurred \(([^)]+)\)/)?.[1] ?? "COMMAND_FAILED";
    throw new AwsError(code, args.slice(0, 2).join(" "));
  }
}

export interface Platform {
  account_id: string;
  region: string;
  environment: string;
  name: string;
  cluster_arn: string;
  cluster_name: string;
  subnet_ids: string[];
  worker_security_group_id: string;
  database_host: string;
  database_identifier: string;
  secret_arns: Record<string, string>;
  log_groups: Record<string, string>;
  repository_url: string;
  app_origin: string;
  assets_bucket: string;
  distribution_id: string;
}

const PLATFORM_MISMATCH =
  "Platform output does not match the expected account, region and application";

function namesThisAccount(p: Platform): boolean {
  const target = deploymentTarget(p.environment);
  return (
    p.account_id === target.account_id &&
    p.region === target.region &&
    p.name === target.name
  );
}

function namesThisDeployment(p: Platform): boolean {
  return (
    p.repository_url ===
      `${p.account_id}.dkr.ecr.${p.region}.amazonaws.com/${p.name}` &&
    Array.isArray(p.subnet_ids) &&
    p.subnet_ids.length === 2 &&
    Boolean(p.database_host?.endsWith("." + p.region + ".rds.amazonaws.com")) &&
    Boolean(p.secret_arns) &&
    Boolean(p.log_groups)
  );
}

/** The origin must be a bare HTTPS host: no credentials, port, path or query. */
export function isDeploymentOrigin(
  value: string,
  environment: string,
): boolean {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  const target = deploymentTarget(environment);
  // URL.origin omits user information, paths, queries and fragments.
  return (
    value === origin.origin &&
    origin.protocol === "https:" &&
    !origin.port &&
    (target.app_origin === null
      ? origin.hostname.endsWith(".cloudfront.net")
      : value === target.app_origin)
  );
}

function requireOwnSecrets(p: Platform): void {
  for (const name of [
    "runtime",
    "migration",
    "diagnostic",
    "gate",
    "session",
    "anthropic",
  ]) {
    const prefix = `arn:aws:secretsmanager:${p.region}:${p.account_id}:secret:/one-door/${p.environment}/${name}-`;
    if (!p.secret_arns[name]?.startsWith(prefix))
      throw new Error("Secret reference is outside this deployment: " + name);
  }
}

export function readPlatform(filename: string): Platform {
  const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (!value || typeof value !== "object")
    throw new Error("Invalid platform output");
  const p = value as Platform;
  if (!namesThisAccount(p) || !namesThisDeployment(p))
    throw new Error(PLATFORM_MISMATCH);
  if (!isDeploymentOrigin(p.app_origin ?? "", p.environment))
    throw new Error("Invalid application origin");
  requireOwnSecrets(p);
  return p;
}

export function requireAccount(
  p: Pick<Platform, "account_id" | "region">,
): void {
  const identity = aws<{ Account: string }>([
    "sts",
    "get-caller-identity",
    "--region",
    p.region,
  ]);
  if (identity.Account !== p.account_id)
    throw new Error("AWS account mismatch; no changes attempted");
}
