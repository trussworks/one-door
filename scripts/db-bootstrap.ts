// One-off administrative bootstrap for a fresh RDS instance. Creates the
// C-collation application database and the three roles, applies grants and
// default privileges, and verifies the result. Idempotent; refuses unexpected
// ownership rather than replacing existing state. Never prints a credential,
// a connection URL, or raw failing SQL.
import { isMain } from "./is-main.mjs";

import postgres from "postgres";

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
// Roles are cluster-wide while the database is not, so the marker names the
// database a role belongs to: another installation's roles are never reused.
const MARKER_COMMENT = "one-door bootstrap database=";

interface RoleSpec {
  name: string;
  urlEnv: string;
  connectionLimit: number;
  /** Keys are a fixed allowlist; values become quoted literals. */
  settings: Record<string, string>;
}

interface RoleNames {
  migrator: string;
  app: string;
  diagnostic: string;
}

function roleNames(prefix: string): RoleNames {
  return {
    migrator: `${prefix}_migrator`,
    app: `${prefix}_app`,
    diagnostic: `${prefix}_diagnostic`,
  };
}

function roleSpecs(names: RoleNames): RoleSpec[] {
  return [
    {
      name: names.migrator,
      urlEnv: "MIGRATION_DATABASE_URL",
      connectionLimit: 5,
      settings: {
        statement_timeout: "10min",
        lock_timeout: "1min",
        idle_in_transaction_session_timeout: "10min",
      },
    },
    {
      name: names.app,
      urlEnv: "RUNTIME_DATABASE_URL",
      connectionLimit: 50,
      settings: {
        statement_timeout: "30s",
        lock_timeout: "5s",
        idle_in_transaction_session_timeout: "60s",
      },
    },
    {
      name: names.diagnostic,
      urlEnv: "DIAGNOSTIC_DATABASE_URL",
      connectionLimit: 5,
      settings: {
        statement_timeout: "30s",
        lock_timeout: "5s",
        idle_in_transaction_session_timeout: "60s",
        default_transaction_read_only: "on",
      },
    },
  ];
}

function literal(value: string): string {
  if (value.includes("\0")) throw new Error("credential contains NUL");
  return "'" + value.replaceAll("'", "''") + "'";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

interface ParsedRole {
  spec: RoleSpec;
  password: string;
  url: string;
}

function parseRoleUrl(
  env: NodeJS.ProcessEnv,
  spec: RoleSpec,
  target: { host: string; port: number; dbName: string },
): ParsedRole {
  const { host, port, dbName } = target;
  const raw = required(env, spec.urlEnv);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${spec.urlEnv} is not a valid URL`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol))
    throw new Error(`${spec.urlEnv} must use the postgres scheme`);
  if (url.hostname !== host)
    throw new Error(`${spec.urlEnv} host does not match DB_HOST`);
  if (Number(url.port || 5432) !== port)
    throw new Error(`${spec.urlEnv} port does not match DB_PORT`);
  if (url.pathname !== "/" + dbName)
    throw new Error(`${spec.urlEnv} database does not match DB_NAME`);
  if (decodeURIComponent(url.username) !== spec.name)
    throw new Error(`${spec.urlEnv} user must be ${spec.name}`);
  const password = decodeURIComponent(url.password);
  if (password.length < 16)
    throw new Error(`${spec.urlEnv} password must be at least 16 characters`);
  return { spec, password, url: raw };
}

type Sql = postgres.Sql | postgres.TransactionSql;

interface RoleState {
  exists: boolean;
  marker: string | null;
}

interface DatabaseState {
  exists: boolean;
}

function roleState(
  name: string,
  dbName: string,
  row?: {
    elevated: boolean;
    comment: string | null;
  },
): RoleState {
  if (!row) return { exists: false, marker: null };
  if (row.elevated)
    throw new Error(`role ${name} already exists with elevated attributes`);
  const marker = row.comment?.startsWith(MARKER_COMMENT)
    ? row.comment.slice(MARKER_COMMENT.length)
    : null;
  if (marker === null)
    throw new Error(
      `role ${name} exists and was not created by One Door bootstrap; refusing`,
    );
  if (marker !== dbName)
    throw new Error(
      `role ${name} belongs to database ${marker}, not ${dbName}; refusing`,
    );
  return { exists: true, marker };
}

async function databaseState(
  sql: Sql,
  dbName: string,
  migrator: string,
): Promise<DatabaseState> {
  const [database] = await sql<
    { owner: string; encoding: string; collate: string; ctype: string }[]
  >`SELECT pg_get_userbyid(datdba) AS owner,
           pg_encoding_to_char(encoding) AS encoding,
           datcollate AS collate, datctype AS ctype
      FROM pg_database WHERE datname = ${dbName}`;
  if (!database) return { exists: false };
  if (database.owner !== migrator)
    throw new Error(
      `database ${dbName} exists with unexpected owner ${database.owner}`,
    );
  if (
    database.encoding !== "UTF8" ||
    database.collate !== "C" ||
    database.ctype !== "C"
  )
    throw new Error(
      `database ${dbName} exists with unexpected encoding or collation`,
    );
  return { exists: true };
}

/**
 * Refuse unexpected ownership before changing credentials, including on a
 * resumed bootstrap whose roles already exist.
 */
async function preflight(
  sql: Sql,
  specs: RoleSpec[],
  dbName: string,
  migrator: string,
): Promise<{ roles: Map<string, RoleState>; database: DatabaseState }> {
  const names = specs.map((spec) => spec.name);
  const found = await sql<
    {
      rolname: string;
      elevated: boolean;
      comment: string | null;
    }[]
  >`SELECT r.rolname,
           (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
             AS elevated,
           shobj_description(r.oid, 'pg_authid') AS comment
      FROM pg_roles r WHERE r.rolname = ANY(${names})`;
  const byName = new Map(found.map((row) => [row.rolname, row]));
  const roles = new Map(
    names.map((name) => [name, roleState(name, dbName, byName.get(name))]),
  );
  return { roles, database: await databaseState(sql, dbName, migrator) };
}

async function configureRole(
  sql: Sql,
  role: ParsedRole,
  state: RoleState,
  target: { dbName: string; adminIdentifier: string },
): Promise<void> {
  const { dbName, adminIdentifier } = target;
  const { name, connectionLimit, settings } = role.spec;
  // A failing credential statement could echo its SQL; keep the cause private.
  try {
    await sql.unsafe(
      `${state.exists ? "ALTER" : "CREATE"} ROLE ${name} LOGIN ` +
        `PASSWORD ${literal(role.password)} CONNECTION LIMIT ${connectionLimit}`,
    );
  } catch {
    throw new Error(`failed to configure credentials for role ${name}`);
  }
  const [membership] = await sql<{ has_admin: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles role ON role.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE role.rolname = ${name} AND member.rolname = current_user
      AND membership.admin_option
  ) AS has_admin`;
  if (!state.exists && !membership.has_admin)
    await sql.unsafe(
      `GRANT ${name} TO ${adminIdentifier} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
    );
  // RDS denies the custom ALTER ROLE setting. Explicit ADMIN membership
  // allows its non-superuser administrator to use a role comment instead.
  await sql.unsafe(
    `COMMENT ON ROLE ${name} IS ${literal(MARKER_COMMENT + dbName)}`,
  );
  for (const [key, value] of Object.entries(settings))
    await sql.unsafe(`ALTER ROLE ${name} SET ${key} = ${literal(value)}`);
}

async function requireSchemaOwner(sql: Sql, migrator: string): Promise<void> {
  const [schema] = await sql<
    { owner: string }[]
  >`SELECT pg_get_userbyid(nspowner) AS owner
    FROM pg_namespace WHERE nspname = 'public'`;
  if (!schema) throw new Error("schema public is missing");
  if (!["pg_database_owner", migrator].includes(schema.owner))
    throw new Error(
      `schema public has unexpected owner ${schema.owner}; refusing to continue`,
    );
}

async function applyGrants(
  sql: Sql,
  dbName: string,
  names: RoleNames,
): Promise<void> {
  await requireSchemaOwner(sql, names.migrator);
  const statements = [
    `ALTER SCHEMA public OWNER TO ${names.migrator}`,
    `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE "${dbName}" TO ${names.migrator}, ${names.app}, ${names.diagnostic}`,
    `GRANT USAGE ON SCHEMA public TO ${names.app}, ${names.diagnostic}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${names.app}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${names.app}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${names.diagnostic}`,
    // Objects the migrator creates later must arrive already granted;
    // without these, every new migration table breaks the runtime role.
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${names.migrator} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${names.app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${names.migrator} IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${names.app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${names.migrator} IN SCHEMA public
       GRANT SELECT ON TABLES TO ${names.diagnostic}`,
  ];
  for (const statement of statements) await sql.unsafe(statement);
}

async function verifyPrivileges(
  adminToApp: Sql,
  names: RoleNames,
): Promise<void> {
  const privileges = await adminToApp<
    { app_create: boolean; migrator_create: boolean; default_acls: number }[]
  >`SELECT has_schema_privilege(${names.app}, 'public', 'CREATE') AS app_create,
           has_schema_privilege(${names.migrator}, 'public', 'CREATE') AS migrator_create,
           (SELECT count(*)::int FROM pg_default_acl d
             JOIN pg_roles r ON r.oid = d.defaclrole
             WHERE r.rolname = ${names.migrator}) AS default_acls`;
  const check = privileges[0];
  if (!check || check.app_create || !check.migrator_create)
    throw new Error("schema privileges do not match the intended layout");
  if (check.default_acls < 2)
    throw new Error("default privileges for the migration role are missing");
}

async function verifyRoleLogin(
  role: ParsedRole,
  dbName: string,
  ssl: false | "require" | "verify-full",
): Promise<void> {
  const connection = postgres(role.url, {
    max: 1,
    connect_timeout: 10,
    ssl: ssl === false ? undefined : ssl,
    onnotice: () => {},
  });
  try {
    const [row] = await connection<
      { user: string; database: string; read_only: string }[]
    >`SELECT current_user AS user, current_database() AS database,
             current_setting('default_transaction_read_only') AS read_only`;
    if (row?.user !== role.spec.name || row?.database !== dbName)
      throw new Error(`login verification failed for ${role.spec.name}`);
    const expectReadOnly =
      role.spec.settings.default_transaction_read_only === "on";
    if ((row.read_only === "on") !== expectReadOnly)
      throw new Error(
        `read-only default is wrong for ${role.spec.name}; refusing`,
      );
  } catch (error) {
    throw error instanceof Error && error.message.includes(role.spec.name)
      ? error
      : new Error(`could not log in as ${role.spec.name}`);
  } finally {
    await connection.end({ timeout: 5 });
  }
}

function parseSsl(env: NodeJS.ProcessEnv): false | "require" | "verify-full" {
  const sslMode = env.DB_SSLMODE || "verify-full";
  if (!["verify-full", "require", "disable"].includes(sslMode))
    throw new Error("DB_SSLMODE must be verify-full, require, or disable");
  return sslMode === "disable" ? false : (sslMode as "require" | "verify-full");
}

function parseAdmin(env: NodeJS.ProcessEnv): {
  username: string;
  password: string;
} {
  try {
    const parsed = JSON.parse(required(env, "ADMIN_DB_CREDENTIALS"));
    if (
      typeof parsed.username !== "string" ||
      typeof parsed.password !== "string" ||
      !parsed.username ||
      !parsed.password
    )
      throw new Error("shape");
    return parsed;
  } catch {
    throw new Error(
      "ADMIN_DB_CREDENTIALS must be JSON with username and password",
    );
  }
}

function identifier(env: NodeJS.ProcessEnv, name: string, fallback: string) {
  const value = env[name] || fallback;
  if (!IDENTIFIER_PATTERN.test(value))
    throw new Error(`${name} must be a lowercase identifier`);
  return value;
}

async function applyClusterChanges(
  cluster: ReturnType<typeof postgres>,
  application: Sql,
  roles: ParsedRole[],
  target: { dbName: string; adminUsername: string; names: RoleNames },
): Promise<void> {
  const { dbName, adminUsername, names } = target;
  const specs = roles.map((role) => role.spec);
  const exists = await cluster.begin(async (tx) => {
    const state = await preflight(tx, specs, dbName, names.migrator);
    if (state.database.exists)
      await requireSchemaOwner(application, names.migrator);
    const adminIdentifier = `"${adminUsername.replaceAll('"', '""')}"`;
    // A failed marker or later role must not leave an unmarked role or a
    // partially changed set of credentials behind.
    for (const role of roles)
      await configureRole(
        tx,
        role,
        state.roles.get(role.spec.name) ?? { exists: false, marker: null },
        { dbName, adminIdentifier },
      );
    await tx.unsafe(
      `GRANT ${names.migrator} TO ${adminIdentifier} WITH INHERIT TRUE, SET TRUE`,
    );
    return state.database.exists;
  });
  if (exists) return;
  // Deterministic collation, matching compose.yaml's --locale=C initdb.
  await cluster.unsafe(
    `CREATE DATABASE "${dbName}" OWNER ${names.migrator} TEMPLATE template0 ` +
      `ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
}

export async function runBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const host = required(env, "DB_HOST");
  const port = Number(env.DB_PORT || 5432);
  const dbName = identifier(env, "DB_NAME", "one_door");
  // Roles are cluster-wide; a test run uses its own prefix so it never
  // touches the roles a real installation owns.
  const names = roleNames(identifier(env, "DB_ROLE_PREFIX", "one_door"));
  const ssl = parseSsl(env);
  const admin = parseAdmin(env);

  const roles = roleSpecs(names).map((spec) =>
    parseRoleUrl(env, spec, { host, port, dbName }),
  );

  const adminOptions = {
    host,
    port,
    username: admin.username,
    password: admin.password,
    max: 1,
    connect_timeout: 10,
    ssl: ssl === false ? undefined : ssl,
    onnotice: () => {},
  };

  const cluster = postgres({ ...adminOptions, database: "postgres" });
  const application = postgres({ ...adminOptions, database: dbName });
  try {
    await applyClusterChanges(cluster, application, roles, {
      dbName,
      adminUsername: admin.username,
      names,
    });
    await applyGrants(application, dbName, names);
    await verifyPrivileges(application, names);
  } finally {
    await Promise.all([
      cluster.end({ timeout: 5 }),
      application.end({ timeout: 5 }),
    ]);
  }
  for (const role of roles) await verifyRoleLogin(role, dbName, ssl);

  console.log(
    `bootstrap verified: database ${dbName} (C/UTF8), roles ` +
      roles.map((role) => role.spec.name).join(", "),
  );
}

if (isMain(import.meta)) {
  try {
    await runBootstrap();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "bootstrap failed");
    process.exitCode = 1;
  }
}
