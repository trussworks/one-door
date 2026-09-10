// Exercises scripts/db-bootstrap.ts against a live PostgreSQL cluster:
// preflight refusal before any write, fresh bootstrap, role privileges, web
// startup validation, idempotent rerun, and credential protection. Uses a
// run-unique role prefix and uniquely named databases; everything created is
// retained and reported, never dropped (test databases are evidence).
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { runBootstrap } from "../scripts/db-bootstrap.ts";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const adminRaw = process.env.DATABASE_URL;
if (!adminRaw)
  throw new Error("Set DATABASE_URL to an admin URL for bootstrap tests");
const adminUrl = new URL(adminRaw);
const host = adminUrl.hostname;
const port = Number(adminUrl.port || 5432);
const admin = {
  username: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
};

const suffix = randomBytes(4).toString("hex");
const prefix = `one_door_bs_${suffix}`;
const dbName = `${prefix}_main`;
const decoyName = `${prefix}_decoy`;
const roles = {
  migrator: `${prefix}_migrator`,
  app: `${prefix}_app`,
  diagnostic: `${prefix}_diagnostic`,
};
// A quote and a percent sign exercise SQL-literal and URL escaping.
const secret = (label: string) =>
  `p'%${label}-${randomBytes(12).toString("hex")}`;
const passwords = {
  [roles.migrator]: secret("mig"),
  [roles.app]: secret("app"),
  [roles.diagnostic]: secret("diag"),
};
const candidate = {
  [roles.migrator]: secret("mig2"),
  [roles.app]: secret("app2"),
  [roles.diagnostic]: secret("diag2"),
};
const roleUrl = (
  role: string,
  database: string,
  from: Record<string, string> = passwords,
) =>
  `postgresql://${role}:${encodeURIComponent(from[role])}@${host}:${port}/${database}`;

const envFor = (
  database: string,
  from: Record<string, string> = passwords,
): NodeJS.ProcessEnv => ({
  ...process.env,
  DB_HOST: host,
  DB_PORT: String(port),
  DB_NAME: database,
  DB_ROLE_PREFIX: prefix,
  DB_SSLMODE: "disable",
  ADMIN_DB_CREDENTIALS: JSON.stringify(admin),
  MIGRATION_DATABASE_URL: roleUrl(roles.migrator, database, from),
  RUNTIME_DATABASE_URL: roleUrl(roles.app, database, from),
  DIAGNOSTIC_DATABASE_URL: roleUrl(roles.diagnostic, database, from),
});
const env = envFor(dbName);

const adminDb = (database: string) =>
  postgres({
    host,
    port,
    username: admin.username,
    password: admin.password,
    database,
    max: 1,
    onnotice: () => {},
  });

async function existingRoles(): Promise<string[]> {
  const cluster = adminDb("postgres");
  try {
    const found = await cluster<
      { rolname: string }[]
    >`SELECT rolname FROM pg_roles WHERE rolname = ANY(${Object.values(roles)})`;
    return found.map((row) => row.rolname);
  } finally {
    await cluster.end({ timeout: 5 });
  }
}

async function canLogIn(url: string): Promise<boolean> {
  const connection = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    await connection`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await connection.end({ timeout: 5 });
  }
}

// ── A mismatched database is refused before any role is written ───────────
const cluster = adminDb("postgres");
try {
  await cluster.unsafe(`CREATE DATABASE "${decoyName}"`);
} finally {
  await cluster.end({ timeout: 5 });
}
await assert.rejects(
  runBootstrap(envFor(decoyName)),
  /unexpected owner/,
  "an admin-owned database must be refused",
);
assert.deepEqual(
  await existingRoles(),
  [],
  "preflight must refuse before creating or altering any role",
);

// ── Fresh bootstrap, then migrations as the migration role ────────────────
await runBootstrap(env);
const migration = await run(
  process.execPath,
  ["--experimental-strip-types", "scripts/db-migrate.ts"],
  {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: env.MIGRATION_DATABASE_URL },
  },
);
assert.match(migration.stdout, /Applied \d+ migration\(s\)\./);

function checkDatabaseAcceptance(expectedFailures = 0) {
  const result = spawnSync(process.execPath, ["scripts/rds-acceptance.mjs"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  const evidence = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const summary = evidence.at(-1);
  assert.equal(summary.acceptance, "rds");
  assert.equal(summary.fail, expectedFailures, result.stdout);
  assert.equal(summary.limit, 5, "only TLS needs the actual RDS server");
  assert.equal(
    summary.complete,
    false,
    "local plaintext is not RDS acceptance",
  );
  assert.equal(result.status, 1);
  assert.equal(
    evidence.find((row) => row.check === "roles.attributes")?.status,
    expectedFailures ? "fail" : "pass",
    "acceptance must verify the role comments written by bootstrap",
  );
}

checkDatabaseAcceptance();

// ── Runtime role: DML and sequences yes, DDL no ───────────────────────────
const app = postgres(env.RUNTIME_DATABASE_URL as string, {
  max: 1,
  onnotice: () => {},
});
try {
  const [dml] = await app<
    { can_insert: boolean; can_create: boolean }[]
  >`SELECT has_table_privilege('requests', 'INSERT') AS can_insert,
           has_schema_privilege('public', 'CREATE') AS can_create`;
  assert.equal(
    dml?.can_insert,
    true,
    "runtime role can write migration tables",
  );
  assert.equal(dml?.can_create, false, "runtime role cannot create objects");
  const [seq] = await app<
    { next: string }[]
  >`SELECT nextval('request_display_id_seq')::text AS next`;
  assert.ok(Number(seq?.next) >= 2000, "runtime role can use the sequence");
  await assert.rejects(
    app`CREATE TABLE bootstrap_ddl_probe (id int)`,
    /permission denied|read-only/i,
    "runtime DDL must be refused",
  );
} finally {
  await app.end({ timeout: 5 });
}

// ── Diagnostic role: SELECT yes, writes refused by read-only default ──────
const diagnostic = postgres(env.DIAGNOSTIC_DATABASE_URL as string, {
  max: 1,
  onnotice: () => {},
});
try {
  const ledger = await diagnostic<
    { count: string }[]
  >`SELECT count(*)::text AS count FROM _one_door_migrations`;
  assert.ok(Number(ledger[0]?.count) > 0, "diagnostic role reads the ledger");
  await assert.rejects(
    diagnostic`INSERT INTO _one_door_migrations (name, sha256) VALUES ('x', 'x')`,
    /read-only/i,
    "diagnostic writes must be refused",
  );
} finally {
  await diagnostic.end({ timeout: 5 });
}

// ── Web startup validation against this database as the runtime role ──────
process.env.DATABASE_URL = env.RUNTIME_DATABASE_URL;
process.env.DEMO_ACCESS_CODE ||= randomBytes(12).toString("hex");
process.env.SESSION_SECRET ||= randomBytes(32).toString("hex");
const { validateWebStartup } = await import("../src/server/startup.ts");
await validateWebStartup();

const ledgerAdmin = adminDb(dbName);
try {
  const [last] = await ledgerAdmin<
    { name: string; sha256: string }[]
  >`SELECT name, sha256 FROM _one_door_migrations ORDER BY name DESC LIMIT 1`;
  assert.ok(last, "ledger has applied migrations");

  await ledgerAdmin`UPDATE _one_door_migrations
    SET sha256 = ${"0".repeat(64)} WHERE name = ${last.name}`;
  await assert.rejects(
    validateWebStartup(),
    /differs from this image/,
    "a changed applied migration must block startup",
  );
  await ledgerAdmin`UPDATE _one_door_migrations
    SET sha256 = ${last.sha256} WHERE name = ${last.name}`;

  await ledgerAdmin`DELETE FROM _one_door_migrations WHERE name = ${last.name}`;
  await assert.rejects(
    validateWebStartup(),
    /not applied/,
    "a missing migration must block startup",
  );
  await ledgerAdmin`INSERT INTO _one_door_migrations (name, sha256)
    VALUES (${last.name}, ${last.sha256})`;

  // An applied migration newer than the image stays allowed, so a rolled-back
  // image still starts. The probe row is retained rather than deleted.
  await ledgerAdmin`INSERT INTO _one_door_migrations (name, sha256)
    VALUES ('9999_future_probe.sql', ${"1".repeat(64)})`;
  await validateWebStartup();
} finally {
  await ledgerAdmin.end({ timeout: 5 });
}

// ── Idempotent rerun preserves the migrated database ──────────────────────
await runBootstrap(env);
const recheck = adminDb(dbName);
try {
  const [after] = await recheck<
    { count: string }[]
  >`SELECT count(*)::text AS count FROM _one_door_migrations`;
  assert.ok(Number(after?.count) > 0, "rerun preserved the migration ledger");
} finally {
  await recheck.end({ timeout: 5 });
}

// ── A refused run never changes existing role credentials ─────────────────
await assert.rejects(
  runBootstrap(envFor(decoyName, candidate)),
  /belongs to database|unexpected owner/,
  "roles bound to one database must not be adopted by another",
);
for (const role of Object.values(roles)) {
  assert.equal(
    await canLogIn(roleUrl(role, dbName)),
    true,
    `${role} keeps its original password after a refused run`,
  );
  assert.equal(
    await canLogIn(roleUrl(role, dbName, candidate)),
    false,
    `${role} never received the refused run's candidate password`,
  );
}

const schemaAdmin = adminDb(dbName);
try {
  const identifier = '"' + admin.username.replaceAll('"', '""') + '"';
  await schemaAdmin.unsafe(`ALTER SCHEMA public OWNER TO ${identifier}`);
  await assert.rejects(
    runBootstrap(envFor(dbName, candidate)),
    /schema public has unexpected owner/,
  );
  for (const role of Object.values(roles))
    assert.equal(
      await canLogIn(roleUrl(role, dbName)),
      true,
      "schema ownership refusal must not change a role password",
    );
} finally {
  await schemaAdmin.unsafe(`ALTER SCHEMA public OWNER TO ${roles.migrator}`);
  await schemaAdmin.end({ timeout: 5 });
}

// ── Mismatched secret URLs fail before any connection ─────────────────────
const markerAdmin = adminDb("postgres");
try {
  const [before] = await markerAdmin<
    { comment: string }[]
  >`SELECT shobj_description(oid, 'pg_authid') AS comment
    FROM pg_roles WHERE rolname = ${roles.migrator}`;
  assert.ok(before.comment);
  try {
    await markerAdmin.unsafe(
      `COMMENT ON ROLE ${roles.migrator} IS 'Maintained by another operator'`,
    );
    await assert.rejects(
      runBootstrap(envFor(dbName, candidate)),
      /was not created by One Door bootstrap/,
    );
    assert.equal(
      await canLogIn(env.MIGRATION_DATABASE_URL!),
      true,
      "a foreign ownership comment must be refused without changing credentials",
    );
    checkDatabaseAcceptance(1);
  } finally {
    await markerAdmin.unsafe(
      `COMMENT ON ROLE ${roles.migrator} IS '${before.comment.replaceAll("'", "''")}'`,
    );
  }
} finally {
  await markerAdmin.end({ timeout: 5 });
}

await assert.rejects(
  runBootstrap({
    ...env,
    RUNTIME_DATABASE_URL: roleUrl(roles.app, "other_db"),
  }),
  /does not match DB_NAME/,
);
await assert.rejects(
  runBootstrap({ ...env, RUNTIME_DATABASE_URL: env.MIGRATION_DATABASE_URL }),
  new RegExp(`user must be ${roles.app}`),
);

// RDS administrators have CREATEDB/CREATEROLE, not PostgreSQL SUPERUSER.
async function checkRestrictedAdministrator() {
  const operator = `${prefix}_operator`;
  const operatorPassword = randomBytes(24).toString("hex");
  const limitedPrefix = `${prefix}_limited`;
  const limitedDb = `${limitedPrefix}_main`;
  const privileged = adminDb("postgres");
  try {
    await privileged.unsafe(
      `CREATE ROLE ${operator} LOGIN NOSUPERUSER CREATEDB CREATEROLE PASSWORD '${operatorPassword}'`,
    );
    const limitedEnv: NodeJS.ProcessEnv = {
      ...env,
      ADMIN_DB_CREDENTIALS: JSON.stringify({
        username: operator,
        password: operatorPassword,
      }),
      DB_ROLE_PREFIX: limitedPrefix,
      DB_NAME: limitedDb,
    };
    for (const [key, suffix] of Object.entries({
      MIGRATION_DATABASE_URL: "migrator",
      RUNTIME_DATABASE_URL: "app",
      DIAGNOSTIC_DATABASE_URL: "diagnostic",
    })) {
      const url = new URL(env[key]!);
      url.username = `${limitedPrefix}_${suffix}`;
      url.pathname = "/" + limitedDb;
      limitedEnv[key] = url.href;
    }
    await runBootstrap(limitedEnv);
    await runBootstrap(limitedEnv);
    await privileged.unsafe(
      `REVOKE ADMIN OPTION FOR ${limitedPrefix}_app FROM ${operator}`,
    );
    const nextUrl = new URL(limitedEnv.MIGRATION_DATABASE_URL!);
    nextUrl.password = randomBytes(24).toString("hex");
    await assert.rejects(
      runBootstrap({ ...limitedEnv, MIGRATION_DATABASE_URL: nextUrl.href }),
      /failed to configure credentials/,
      "a later role failure must reject the bootstrap",
    );
    assert.equal(
      await canLogIn(limitedEnv.MIGRATION_DATABASE_URL!),
      true,
      "a later failure rolls back the earlier role's password change",
    );
    assert.equal(
      await canLogIn(nextUrl.href),
      false,
      "the failed bootstrap never installs its candidate password",
    );
    await privileged.unsafe(
      `GRANT ${limitedPrefix}_app TO ${operator} WITH ADMIN TRUE`,
    );
    console.log(
      `Restricted administrator checks passed; retained ${operator}, ${limitedPrefix}_migrator, ${limitedPrefix}_app, ${limitedPrefix}_diagnostic and database ${limitedDb}.`,
    );
  } finally {
    await privileged.end({ timeout: 5 });
  }
}

await checkRestrictedAdministrator();

console.log(
  `Bootstrap checks passed. Retained for inspection (never dropped): ` +
    `databases ${dbName}, ${decoyName}; cluster roles ${Object.values(roles).join(", ")} ` +
    `(with ${roles.migrator} membership granted to ${admin.username}).`,
);
