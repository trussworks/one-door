import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  aws,
  AwsError,
  readPlatform,
  requireAccount,
  resolveTool,
} from "./aws.ts";
import { isMain } from "../is-main.mjs";
import type { Platform } from "./aws.ts";

function get(p: Platform, arn: string): string | null {
  try {
    return aws<{ SecretString: string }>([
      "secretsmanager",
      "get-secret-value",
      "--region",
      p.region,
      "--secret-id",
      arn,
    ]).SecretString;
  } catch (error) {
    if (error instanceof AwsError && error.code === "ResourceNotFoundException")
      return null;
    throw error;
  }
}

function install(p: Platform, name: string, create: () => string): string {
  const arn = p.secret_arns[name];
  if (!arn) throw new Error("Missing secret reference: " + name);
  const previous = get(p, arn);
  if (previous !== null) return previous;
  const value = create();
  // The CLI reads --cli-input-json files twice, so a stream cannot carry
  // that document. The service's secret-string argument reads stdin once.
  aws(
    [
      "secretsmanager",
      "put-secret-value",
      "--region",
      p.region,
      "--secret-id",
      arn,
      "--secret-string",
      "file:///dev/stdin",
    ],
    value,
  );
  if (get(p, arn) !== value)
    throw new Error("Secret persistence not confirmed: " + name);
  console.log("Secret installed and verified:", name);
  return value;
}

function installSecrets(platformFile: string, accessFile: string): void {
  const p = readPlatform(platformFile);
  requireAccount(p);

  for (const [name, username] of Object.entries({
    runtime: "one_door_app",
    migration: "one_door_migrator",
    diagnostic: "one_door_diagnostic",
  })) {
    const value = install(p, name, () => {
      const url = new URL("postgresql://placeholder/one_door");
      url.hostname = p.database_host;
      url.port = "5432";
      url.username = username;
      url.password = randomBytes(32).toString("hex");
      url.searchParams.set("sslmode", "verify-full");
      return url.href;
    });
    const url = new URL(value);
    if (
      url.hostname !== p.database_host ||
      decodeURIComponent(url.username) !== username ||
      url.pathname !== "/one_door" ||
      url.searchParams.get("sslmode") !== "verify-full"
    ) {
      throw new Error(
        "Existing database secret does not match this deployment: " + name,
      );
    }
  }

  const gate = install(p, "gate", () => randomBytes(18).toString("base64url"));
  install(p, "session", () => randomBytes(48).toString("hex"));
  install(p, "anthropic", () => {
    let key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key && process.platform === "darwin") {
      key = execFileSync(
        resolveTool("security"),
        ["find-generic-password", "-s", "anthropic-api", "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    }
    if (!key) throw new Error("Runtime Anthropic credential is unavailable");
    return key;
  });

  const details = p.app_origin + "\nAccess code: " + gate + "\n";
  if (existsSync(accessFile)) {
    if (readFileSync(accessFile, "utf8") !== details)
      throw new Error(
        "Existing private access file differs; choose a new path",
      );
  } else {
    writeFileSync(accessFile, details, { mode: 0o600, flag: "wx" });
  }
  console.log("Private access details written:", accessFile);
}

if (isMain(import.meta)) {
  const [platformFile, accessFile] = process.argv.slice(2);
  if (!platformFile || !accessFile)
    throw new Error(
      "Usage: install-secrets.ts PLATFORM_JSON PRIVATE_ACCESS_FILE",
    );
  installSecrets(platformFile, accessFile);
}
