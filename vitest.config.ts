import { randomBytes } from "node:crypto";
import { configDefaults, defineConfig } from "vitest/config";
import { unitEnvironment } from "./test/environment.ts";

// Unit-test failures may serialize child-process arguments. Keep real service
// credentials out of that process. Vite loads .env after resolving this config,
// so envDir: false must also remain to prevent reintroducing those values.
const inherited = unitEnvironment(process.env);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, inherited, {
  DATABASE_URL: "postgresql://unit@127.0.0.1:1/one_door_unit",
  DEMO_ACCESS_CODE: randomBytes(16).toString("hex"),
  SESSION_SECRET: randomBytes(32).toString("hex"),
  ANTHROPIC_API_KEY: randomBytes(24).toString("hex"),
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  AWS_EC2_METADATA_DISABLED: "true",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

export default defineConfig({
  envDir: false,
  test: { exclude: [...configDefaults.exclude, ".harness/**"] },
});
