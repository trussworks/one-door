// Exercises scripts/db-inspect.ts as the operator would run it: through the
// SELECT-only diagnostic role the bootstrap creates, against a live cluster.
// Requires DATABASE_URL to be an administrative URL on the dedicated
// validation server. Every database and role it creates is retained.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { runBootstrap } from "../../scripts/db-bootstrap.ts";
import { inspectDatabase } from "../../scripts/db-inspect.ts";
import { buildSeedData } from "../../src/seed/build.ts";
import { contentHash } from "../../src/seed/stable.ts";
import { migrationChecksums } from "../../scripts/deploy/release-record.ts";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const adminRaw = process.env.DATABASE_URL;
if (!adminRaw)
  throw new Error("Set DATABASE_URL to an admin URL on the validation server");
const adminUrl = new URL(adminRaw);
const host = adminUrl.hostname;
const port = Number(adminUrl.port || 5432);
if (port === 5432)
  throw new Error(
    "Use the dedicated validation server, not the development database",
  );
const admin = {
  username: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
};

const prefix = `one_door_ins_${randomBytes(4).toString("hex")}`;
const dbName = `${prefix}_main`;
const roles = {
  migrator: `${prefix}_migrator`,
  app: `${prefix}_app`,
  diagnostic: `${prefix}_diagnostic`,
};
const secret = (label: string) =>
  `p'%${label}-${randomBytes(12).toString("hex")}`;
const passwords = Object.fromEntries(
  Object.entries(roles).map(([key, role]) => [role, secret(key)]),
);
const roleUrl = (role: string) =>
  `postgresql://${role}:${encodeURIComponent(passwords[role])}@${host}:${port}/${dbName}`;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DB_HOST: host,
  DB_PORT: String(port),
  DB_NAME: dbName,
  DB_ROLE_PREFIX: prefix,
  DB_SSLMODE: "disable",
  ADMIN_DB_CREDENTIALS: JSON.stringify(admin),
  MIGRATION_DATABASE_URL: roleUrl(roles.migrator),
  RUNTIME_DATABASE_URL: roleUrl(roles.app),
  DIAGNOSTIC_DATABASE_URL: roleUrl(roles.diagnostic),
};

await runBootstrap(env);
await run(
  process.execPath,
  ["--experimental-strip-types", "scripts/db-migrate.ts"],
  {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: env.MIGRATION_DATABASE_URL },
  },
);
await run(
  process.execPath,
  ["--experimental-strip-types", "scripts/db-seed.ts"],
  {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: env.MIGRATION_DATABASE_URL },
  },
);

// ── The inspector reports collation, tables and full-row digests ──────────
const diagnostic = postgres(env.DIAGNOSTIC_DATABASE_URL as string, {
  max: 1,
  onnotice: () => {},
});
let first: Awaited<ReturnType<typeof inspectDatabase>>;
try {
  first = await inspectDatabase(diagnostic);
  assert.equal(first.database.name, dbName);
  assert.equal(first.database.encoding, "UTF8");
  assert.equal(first.database.collation, "C");
  assert.ok(
    first.tables._one_door_migrations.rows > 0,
    "the migration ledger is visible to the diagnostic role",
  );
  assert.match(first.tables.requests.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    first.migrations,
    migrationChecksums(repoRoot + "/migrations"),
  );
  assert.equal(first.fixtures.reference, contentHash(buildSeedData()));

  const repeat = await inspectDatabase(diagnostic);
  assert.deepEqual(repeat, first, "an unchanged database digests identically");
} finally {
  await diagnostic.end({ timeout: 5 });
}

// ── A write through the diagnostic role stays refused ─────────────────────
const writer = postgres(env.DIAGNOSTIC_DATABASE_URL as string, {
  max: 1,
  onnotice: () => {},
});
try {
  await assert.rejects(
    writer`INSERT INTO actors (id, kind, display_name)
      VALUES (gen_random_uuid(), 'visitor', 'refused')`,
    /read-only/i,
    "the inspector's role cannot write",
  );
} finally {
  await writer.end({ timeout: 5 });
}

// ── A real change moves exactly the digest of the table that changed ──────
const application = postgres(env.RUNTIME_DATABASE_URL as string, {
  max: 1,
  onnotice: () => {},
});
try {
  await application`INSERT INTO actors (id, kind, display_name)
    VALUES (gen_random_uuid(), 'visitor', 'inspector check')`;
} finally {
  await application.end({ timeout: 5 });
}
const after = postgres(env.DIAGNOSTIC_DATABASE_URL as string, {
  max: 1,
  onnotice: () => {},
});
try {
  const second = await inspectDatabase(after);
  assert.equal(second.tables.actors.rows, first.tables.actors.rows + 1);
  assert.notEqual(second.tables.actors.sha256, first.tables.actors.sha256);
  assert.equal(
    second.tables._one_door_migrations.sha256,
    first.tables._one_door_migrations.sha256,
    "an unrelated table keeps its digest",
  );
} finally {
  await after.end({ timeout: 5 });
}

console.log(
  `Inspector checks passed on ${host}:${port}. Retained for inspection ` +
    `(never dropped): database ${dbName}; roles ${Object.values(roles).join(", ")}.`,
);
