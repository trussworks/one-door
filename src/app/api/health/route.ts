import postgres from "postgres";
import { serverEnv } from "../../../db/env.ts";

export async function GET() {
  let connection: ReturnType<typeof postgres> | undefined;
  try {
    connection = postgres(serverEnv().DATABASE_URL, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    });
    await connection`SELECT id FROM model_jobs LIMIT 0`;
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await connection?.end({ timeout: 1 });
  }
}
