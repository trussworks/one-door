import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { serverEnv } from "./env.ts";
import * as schema from "./schema.ts";

export function createDatabase(databaseUrl = serverEnv().DATABASE_URL) {
  const sql = postgres(databaseUrl);
  return { db: drizzle(sql, { schema }), sql };
}
