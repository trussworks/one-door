import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { serverEnv } from "./env.ts";
import * as schema from "./schema.ts";

// postgres.js reads no PG* environment variables and defaults connect_timeout
// to 30 seconds, so an unreachable database would hold every request that long.
export function createDatabase(databaseUrl = serverEnv().DATABASE_URL) {
  const sql = postgres(databaseUrl, { connect_timeout: 5 });
  return { db: drizzle(sql, { schema }), sql };
}
