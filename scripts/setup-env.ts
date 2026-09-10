import { randomBytes } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isMain } from "./is-main.mjs";

export async function createLocalEnvironment(directory: string) {
  const localExists = await lstat(resolve(directory, ".env.local")).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (localExists)
    throw Object.assign(new Error("Local configuration already exists"), {
      code: "EEXIST",
    });
  const randomValue = (kind: string) =>
    "od_" + kind + "_" + randomBytes(32).toString("hex");
  const password = randomValue("db");
  const code = randomValue("demo");
  const secret = randomValue("session");
  const url = new URL("postgresql://one_door@localhost:5432/one_door");
  url.password = password;
  const content = [
    "POSTGRES_USER=one_door",
    "POSTGRES_PASSWORD=" + password,
    "DATABASE_URL=" + url.href,
    "DEMO_ACCESS_CODE=" + code,
    "SESSION_SECRET=" + secret,
    "APP_ORIGIN=",
    "ANTHROPIC_API_KEY=",
    "",
  ].join("\n");
  // Exclusive creation preserves an existing database connection and signing key.
  await writeFile(resolve(directory, ".env"), content, {
    mode: 0o600,
    flag: "wx",
  });
}

if (isMain(import.meta)) {
  try {
    await createLocalEnvironment(process.cwd());
    console.log("Created .env with private database and demo credentials.");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === "EEXIST"
        ? "Local configuration already exists; nothing was changed."
        : "Could not create the local environment file.",
    );
    process.exitCode = 1;
  }
}
