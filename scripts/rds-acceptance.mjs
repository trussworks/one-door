// Database acceptance runs from the image as a separate one-off task. Its
// transactions roll back every write probe; failed or unexecuted checks must
// never report a successful verification.
import { rootCertificates } from "node:tls";
import { isMain } from "./is-main.mjs";

import postgres from "postgres";

const CONNECT_TIMEOUT_SECONDS = 10;
const ROLE_COMMENT_MARKER = "one-door bootstrap database=";

/** Thrown to roll a probe transaction back after it has proved its point. */
class Rollback extends Error {}

/** Error identity only: a message can echo a parameter or a credential. */
export function errorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
    ? code
    : "UNIDENTIFIED";
}

export function summarize(results) {
  const counts = { pass: 0, fail: 0, limit: 0 };
  for (const result of results) counts[result.status] += 1;
  return {
    ...counts,
    checks: results.length,
    // Environment limits are not evidence. Acceptance is complete only when
    // every check actually ran.
    complete: counts.fail === 0 && counts.limit === 0,
    exitCode: counts.fail === 0 && counts.limit === 0 ? 0 : 1,
  };
}

/**
 * A refusal check passes only when the statement was refused for the expected
 * reason. A statement that succeeds means the privilege is too broad, which is
 * a failure however convenient the outcome looks.
 */
export function judgeRefusal(expectedCodes, outcome) {
  if (outcome.succeeded)
    return {
      status: "fail",
      detail: { refused: false, reason: "the statement was permitted" },
    };
  return expectedCodes.includes(outcome.code)
    ? { status: "pass", detail: { refused: true, code: outcome.code } }
    : {
        status: "fail",
        detail: {
          refused: true,
          code: outcome.code,
          reason: "refused for an unexpected reason",
        },
      };
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function roleName(url) {
  return decodeURIComponent(new URL(url).username);
}

function baseOptions(sslMode) {
  return {
    max: 1,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: 5,
    connection: {
      application_name: "one-door-database-verification",
      statement_timeout: 15000,
      lock_timeout: 5000,
    },
    onnotice: () => {},
    ...(sslMode === "disable" ? {} : { ssl: sslMode }),
  };
}

async function withConnection(url, options, action) {
  const sql = postgres(url, options);
  try {
    return await action(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Runs a statement expected to be refused, and always rolls back. */
async function attempt(sql, statement) {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(statement);
      throw new Rollback();
    });
    return { succeeded: true, code: "NONE" };
  } catch (error) {
    if (error instanceof Rollback) return { succeeded: true, code: "NONE" };
    return { succeeded: false, code: errorCode(error) };
  }
}

async function connects(url, options) {
  try {
    await withConnection(url, options, (sql) => sql`SELECT 1`);
    return { succeeded: true, code: "NONE" };
  } catch (error) {
    return { succeeded: false, code: errorCode(error) };
  }
}

// ── transport ────────────────────────────────────────────────────────
const TLS_CHECKS = [
  "tls.every-path-verifies",
  "tls.verified-connection",
  "tls.untrusted-authority-refused",
  "tls.wrong-hostname-refused",
  "tls.plaintext-refused",
];

function tlsRefusals() {
  return [
    [
      "tls.untrusted-authority-refused",
      // A real authority that did not issue this server's certificate.
      { ...baseOptions("verify-full"), ssl: { ca: [rootCertificates[0]] } },
      [
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "CERT_SIGNATURE_FAILURE",
      ],
    ],
    [
      "tls.wrong-hostname-refused",
      {
        ...baseOptions("verify-full"),
        ssl: { servername: "not-this-database.invalid" },
      },
      ["ERR_TLS_CERT_ALTNAME_INVALID"],
    ],
    [
      "tls.plaintext-refused",
      { ...baseOptions("disable"), ssl: false },
      ["28000", "08006"],
    ],
  ];
}

async function recordVerifiedConnection(runtime, record) {
  const verified = await connects(runtime, baseOptions("verify-full"));
  if (!verified.succeeded) {
    record("tls.verified-connection", "fail", { code: verified.code });
    return;
  }
  const [session] = await withConnection(
    runtime,
    baseOptions("verify-full"),
    (sql) =>
      sql`SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
  );
  record("tls.verified-connection", session?.ssl ? "pass" : "fail", {
    ssl: session?.ssl ?? false,
    version: session?.version ?? null,
    cipher: session?.cipher ?? null,
  });
}

async function transportChecks(env, record) {
  const sslMode = required(env, "DB_SSLMODE");
  const runtime = required(env, "RUNTIME_DATABASE_URL");

  if (sslMode !== "verify-full") {
    const reason = `DB_SSLMODE is ${sslMode}; this server does not present TLS`;
    for (const check of TLS_CHECKS) record(check, "limit", { reason });
    return;
  }

  // Every path the application uses must demand a verified certificate, not
  // only the path this program happens to open.
  const verifying = [
    "RUNTIME_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "DIAGNOSTIC_DATABASE_URL",
  ]
    .map((name) => new URL(required(env, name)).searchParams.get("sslmode"))
    .filter((mode) => mode === "verify-full").length;
  record("tls.every-path-verifies", verifying === 3 ? "pass" : "fail", {
    pathsRequiringVerifyFull: verifying,
    of: 3,
  });

  await recordVerifiedConnection(runtime, record);
  for (const [check, options, expected] of tlsRefusals()) {
    const judged = judgeRefusal(expected, await connects(runtime, options));
    record(check, judged.status, judged.detail);
  }
}

// ── role separation ──────────────────────────────────────────────────
async function runtimeRoleChecks(env, record) {
  const sslMode = required(env, "DB_SSLMODE");
  const runtime = required(env, "RUNTIME_DATABASE_URL");
  const diagnostic = required(env, "DIAGNOSTIC_DATABASE_URL");

  await withConnection(runtime, baseOptions(sslMode), async (sql) => {
    await recordRuntimePrivileges(sql, record);
    await recordRuntimeWritePath(sql, record);
    await recordRefusals(
      sql,
      record,
      ["42501"],
      [
        ["runtime.create-refused", "CREATE TABLE acceptance_probe (id int)"],
        ["runtime.truncate-refused", "TRUNCATE TABLE actors"],
        ["runtime.drop-refused", "DROP TABLE actors"],
        ["runtime.alter-refused", "ALTER TABLE actors ADD COLUMN probe int"],
      ],
    );
  });

  await withConnection(diagnostic, baseOptions(sslMode), async (sql) => {
    const [readable] = await sql`SELECT count(*)::int AS tables
      FROM information_schema.tables WHERE table_schema = 'public'`;
    record("diagnostic.read", readable.tables > 0 ? "pass" : "fail", readable);
    await recordRefusals(
      sql,
      record,
      ["25006", "42501"],
      [
        [
          "diagnostic.insert-refused",
          "INSERT INTO actors (id, kind, display_name) VALUES (gen_random_uuid(), 'visitor', 'probe')",
        ],
        ["diagnostic.delete-refused", "DELETE FROM actors WHERE false"],
      ],
    );
  });
}

async function recordRefusals(sql, record, expected, statements) {
  for (const [check, statement] of statements) {
    const judged = judgeRefusal(expected, await attempt(sql, statement));
    record(check, judged.status, judged.detail);
  }
}

async function recordRuntimePrivileges(sql, record) {
  const [privileges] = await sql`
    SELECT has_table_privilege('actors', 'INSERT') AS can_insert,
           has_table_privilege('actors', 'SELECT') AS can_select,
           has_table_privilege('actors', 'UPDATE') AS can_update,
           has_table_privilege('actors', 'DELETE') AS can_delete,
           has_sequence_privilege('request_display_id_seq', 'USAGE') AS can_use_sequence,
           has_schema_privilege('public', 'CREATE') AS can_create`;
  const granted = [
    privileges.can_insert,
    privileges.can_select,
    privileges.can_update,
    privileges.can_delete,
    privileges.can_use_sequence,
  ].every(Boolean);
  record(
    "runtime.data-privileges",
    granted && !privileges.can_create ? "pass" : "fail",
    privileges,
  );
}

/** Proves the write path works without leaving a row behind. */
async function recordRuntimeWritePath(sql, record) {
  let wrote = false;
  try {
    await sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO actors (id, kind, display_name)
        VALUES (gen_random_uuid(), 'visitor', 'acceptance probe')
        RETURNING id`;
      await tx`UPDATE actors SET display_name = 'acceptance probe 2' WHERE id = ${row.id}`;
      await tx`DELETE FROM actors WHERE id = ${row.id}`;
      wrote = true;
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback))
      record("runtime.write-path", "fail", { code: errorCode(error) });
  }
  if (wrote) record("runtime.write-path", "pass", { committed: false });
}

/**
 * Default privileges decide whether the next migration's tables are usable.
 * The probe objects are created and dropped inside one rolled-back
 * transaction, so the schema is unchanged.
 */
async function defaultPrivilegeChecks(env, record) {
  const sslMode = required(env, "DB_SSLMODE");
  const migration = required(env, "MIGRATION_DATABASE_URL");
  const runtimeRole = roleName(required(env, "RUNTIME_DATABASE_URL"));
  const diagnosticRole = roleName(required(env, "DIAGNOSTIC_DATABASE_URL"));

  await withConnection(migration, baseOptions(sslMode), async (sql) => {
    let observed = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("CREATE TABLE acceptance_future (id int)");
        await tx.unsafe("CREATE SEQUENCE acceptance_future_seq");
        await tx.unsafe("SELECT nextval('acceptance_future_seq')");
        const [row] = await tx`
          SELECT has_table_privilege(${runtimeRole}, 'acceptance_future', 'INSERT') AS runtime_insert,
                 has_table_privilege(${runtimeRole}, 'acceptance_future', 'SELECT') AS runtime_select,
                 has_table_privilege(${runtimeRole}, 'acceptance_future', 'UPDATE') AS runtime_update,
                 has_table_privilege(${runtimeRole}, 'acceptance_future', 'DELETE') AS runtime_delete,
                 has_sequence_privilege(${runtimeRole}, 'acceptance_future_seq', 'USAGE') AS runtime_sequence,
                 has_table_privilege(${diagnosticRole}, 'acceptance_future', 'SELECT') AS diagnostic_select,
                 has_table_privilege(${diagnosticRole}, 'acceptance_future', 'INSERT') AS diagnostic_insert`;
        observed = row;
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback))
        record("migration.default-privileges", "fail", {
          code: errorCode(error),
        });
    }
    if (observed)
      record(
        "migration.default-privileges",
        futureObjectsAreUsable(observed) ? "pass" : "fail",
        observed,
      );
  });
}

export function futureObjectsAreUsable(observed) {
  const runtimeReady = [
    observed.runtime_insert,
    observed.runtime_select,
    observed.runtime_update,
    observed.runtime_delete,
    observed.runtime_sequence,
  ].every(Boolean);
  return (
    runtimeReady && observed.diagnostic_select && !observed.diagnostic_insert
  );
}

// ── locale, ownership and role attributes ────────────────────────────
async function recordLocale(sql, record, dbName) {
  const [database] = await sql`
    SELECT datname AS name, pg_encoding_to_char(encoding) AS encoding,
           datcollate AS collate, datctype AS ctype,
           pg_get_userbyid(datdba) AS owner
      FROM pg_database WHERE datname = current_database()`;
  const correct = [
    database.name === dbName,
    database.encoding === "UTF8",
    database.collate === "C",
    database.ctype === "C",
  ].every(Boolean);
  record("database.locale", correct ? "pass" : "fail", database);
  return database;
}

async function recordOwnership(sql, record, database, migrationRole) {
  const [schema] = await sql`
    SELECT pg_get_userbyid(nspowner) AS owner,
           has_schema_privilege('public', 'public', 'CREATE') AS public_create
      FROM pg_namespace WHERE nspname = 'public'`;
  const correct = [
    database.owner === migrationRole,
    schema.owner === migrationRole,
    !schema.public_create,
  ].every(Boolean);
  record("database.ownership", correct ? "pass" : "fail", {
    databaseOwner: database.owner,
    ...schema,
  });
}

async function foundationChecks(env, record) {
  const sslMode = required(env, "DB_SSLMODE");
  const dbName = required(env, "DB_NAME");
  const migrationRole = roleName(required(env, "MIGRATION_DATABASE_URL"));
  const roles = [
    roleName(required(env, "RUNTIME_DATABASE_URL")),
    migrationRole,
    roleName(required(env, "DIAGNOSTIC_DATABASE_URL")),
  ];

  await withConnection(
    required(env, "DIAGNOSTIC_DATABASE_URL"),
    baseOptions(sslMode),
    async (sql) => {
      const database = await recordLocale(sql, record, dbName);
      await recordOwnership(sql, record, database, migrationRole);

      const attributes = await sql`
        SELECT r.rolname,
               (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AS elevated,
               r.rolconnlimit,
               shobj_description(r.oid, 'pg_authid') AS comment
          FROM pg_roles r WHERE r.rolname = ANY(${roles})`;
      const marked = attributes.filter(
        (role) => role.comment === ROLE_COMMENT_MARKER + dbName,
      );
      record(
        "roles.attributes",
        attributes.length === roles.length &&
          attributes.every((role) => !role.elevated && role.rolconnlimit > 0) &&
          marked.length === roles.length
          ? "pass"
          : "fail",
        {
          found: attributes.length,
          elevated: attributes.filter((role) => role.elevated).length,
          markedForThisDatabase: marked.length,
        },
      );

      const [readOnly] = await sql`
        SELECT current_setting('default_transaction_read_only') AS diagnostic_default`;
      record(
        "roles.diagnostic-read-only",
        readOnly.diagnostic_default === "on" ? "pass" : "fail",
        readOnly,
      );
      const [bounds] = await sql`
        SELECT current_setting('statement_timeout') AS statement_timeout,
               current_setting('lock_timeout') AS lock_timeout`;
      record(
        "queries.bounded",
        bounds.statement_timeout === "15s" && bounds.lock_timeout === "5s"
          ? "pass"
          : "fail",
        bounds,
      );
    },
  );
}

export async function runAcceptance(env = process.env) {
  const results = [];
  const record = (check, status, detail) => {
    const result = { check, status, detail };
    results.push(result);
    console.log(JSON.stringify(result));
  };
  await transportChecks(env, record);
  await runtimeRoleChecks(env, record);
  await defaultPrivilegeChecks(env, record);
  await foundationChecks(env, record);
  const summary = { acceptance: "rds", ...summarize(results) };
  console.log(JSON.stringify(summary));
  return summary;
}

const invokedAsProgram = isMain(import.meta);
if (invokedAsProgram) {
  try {
    const summary = await runAcceptance();
    if (!summary.complete)
      console.error(
        "Acceptance is incomplete: required evidence is missing or failed.",
      );
    process.exitCode = summary.exitCode;
  } catch (error) {
    console.error(
      JSON.stringify({
        acceptance: "rds",
        complete: false,
        error: errorCode(error),
      }),
    );
    process.exitCode = 1;
  }
}
