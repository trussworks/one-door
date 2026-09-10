import { sql } from "drizzle-orm";
import { z } from "zod";
import { createVisitor } from "../workflow/requester.ts";
import { WorkflowError } from "../workflow/errors.ts";
import { parseInput, requireVisitor, withDb } from "../workflow/shared.ts";
import {
  authConfiguration,
  cookieValue,
  equalSecret,
  HttpError,
  setSessionCookies,
  verifyCookie,
} from "./auth.ts";
import { jsonResponse, readJson } from "./http.ts";

async function countGateAttempt() {
  const rows = await withDb((db) =>
    db.execute(sql`
    INSERT INTO demo_gate_attempts (bucket, attempts, window_started_at)
    VALUES ('shared-gate', 1, now())
    ON CONFLICT (bucket) DO UPDATE SET
      attempts = CASE WHEN demo_gate_attempts.window_started_at < now() - interval '15 minutes'
        THEN 1 ELSE demo_gate_attempts.attempts + 1 END,
      window_started_at = CASE WHEN demo_gate_attempts.window_started_at < now() - interval '15 minutes'
        THEN now() ELSE demo_gate_attempts.window_started_at END
    RETURNING attempts
  `),
  );
  if (Number(rows[0]?.attempts) > 30)
    throw new HttpError(429, "GATE_RATE_LIMITED");
}

async function continuingVisitor(request: Request) {
  const id = verifyCookie(cookieValue(request, "od_visitor"), "visitor");
  if (id) {
    try {
      const visitor = await withDb((db) => requireVisitor(db, id));
      return { visitorId: visitor.id, actorId: visitor.actorId };
    } catch (error) {
      if (!(error instanceof WorkflowError && error.code === "NOT_FOUND"))
        throw error;
    }
  }
  return createVisitor();
}

export async function enterDemo(request: Request) {
  const config = authConfiguration();
  const input = parseInput(
    z.object({ code: z.string().min(1).max(256) }),
    await readJson(request),
  );
  await countGateAttempt();
  if (!equalSecret(input.code, config.DEMO_ACCESS_CODE))
    throw new HttpError(401, "ACCESS_CODE_NOT_RECOGNIZED");
  const visitor = await continuingVisitor(request);
  const response = jsonResponse(visitor);
  setSessionCookies(response, visitor.visitorId);
  return response;
}
