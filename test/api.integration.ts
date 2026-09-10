import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { POST as enter, GET as session } from "../src/app/api/session/route.ts";
import { POST as saveDraft } from "../src/app/api/drafts/route.ts";
import { POST as submit } from "../src/app/api/requests/route.ts";
import { GET as ownRequest } from "../src/app/api/requests/[requestId]/route.ts";
import { GET as ownWork } from "../src/app/api/work/route.ts";
import { POST as ask } from "../src/app/api/clarifications/route.ts";
import { POST as answer } from "../src/app/api/answers/route.ts";
import { POST as saveWip, GET as loadWip } from "../src/app/api/wip/route.ts";
import { POST as adminAction } from "../src/app/api/admin/actions/route.ts";

if (!process.env.DATABASE_URL)
  throw new Error("An isolated DATABASE_URL is required");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
process.env.SESSION_SECRET = randomBytes(32).toString("hex");
process.env.DEMO_ACCESS_CODE = randomBytes(16).toString("hex");
const origin = "http://localhost:3000";

function request(path: string, cookie = "", body?: unknown) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
async function result(response: Response, status = 200) {
  const json = await response.json();
  assert.equal(response.status, status, JSON.stringify(json));
  return json;
}

try {
  await sql`UPDATE demo_gate_attempts SET window_started_at = now() - interval '16 minutes'`;
  await result(await ownWork(request("/api/work")), 401);
  const login = await enter(
    request("/api/session", "", { code: process.env.DEMO_ACCESS_CODE }),
  );
  const actor = await result(login);
  const cookie = cookies(login);
  assert.equal(
    (await result(await session(request("/api/session", cookie)))).actorId,
    actor.actorId,
  );
  const otherLogin = await enter(
    request("/api/session", "", { code: process.env.DEMO_ACCESS_CODE }),
  );
  await result(otherLogin);
  const otherCookie = cookies(otherLogin);
  const [organization] = await sql`SELECT id FROM organizations LIMIT 1`;
  const draft = await result(
    await saveDraft(
      request("/api/drafts", cookie, {
        organizationId: organization.id,
        rawNeed: "An actual saved request over HTTP handlers.",
        state: "ready",
        content: {
          title: "HTTP journey",
          problem: "Keep the same request through review.",
          affectedPeople: "Fictional staff",
          acceptanceCriteria: ["The answer returns to its reviewer"],
        },
      }),
    ),
  );
  const submitted = await result(
    await submit(
      request("/api/requests", cookie, {
        draftId: draft.draftId,
        expectedRowVersion: draft.rowVersion,
        rating: 5,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  const context = {
    params: Promise.resolve({ requestId: submitted.requestId }),
  };
  await result(
    await ownRequest(
      request("/api/requests/" + submitted.requestId, otherCookie),
      context,
    ),
    404,
  );
  const question = await result(
    await ask(
      request("/api/clarifications", otherCookie, {
        requestId: submitted.requestId,
        question: "What must stay intact?",
        expectedRowVersion: 1,
      }),
    ),
  );
  const owned = await result(
    await ownRequest(
      request("/api/requests/" + submitted.requestId, cookie),
      context,
    ),
  );
  assert.equal(owned.answerNeeded, true);
  const scope = {
    actingView: "requester",
    pageKey: "answer",
    subjectKey: question.clarificationId,
  };
  const saved = await result(
    await saveWip(
      request("/api/wip", cookie, {
        ...scope,
        expectedRowVersion: 0,
        payload: { answer: "Unfinished answer" },
        route: "/requests/" + submitted.requestId,
      }),
    ),
  );
  const query = new URLSearchParams(scope).toString();
  assert.equal(
    (await result(await loadWip(request("/api/wip?" + query, cookie)))).payload
      .answer,
    "Unfinished answer",
  );
  assert.equal(
    await result(await loadWip(request("/api/wip?" + query, otherCookie))),
    null,
  );
  await result(
    await saveWip(
      request("/api/wip", cookie, {
        ...scope,
        expectedRowVersion: 0,
        payload: { answer: "Stale overwrite" },
      }),
    ),
    409,
  );
  assert.equal(saved.rowVersion, 1);
  const answered = await result(
    await answer(
      request("/api/answers", cookie, {
        requestId: submitted.requestId,
        clarificationId: question.clarificationId,
        expectedRowVersion: owned.rowVersion,
        answer: "The request identity and the earlier content.",
      }),
    ),
  );
  assert.equal(answered.revisionNumber, 2);
  const [audit] =
    await sql`SELECT actor_id FROM audit_events WHERE subject_id = ${submitted.requestId} AND event_type = 'clarification_asked'`;
  const otherActor = await result(
    await session(request("/api/session", otherCookie)),
  );
  assert.equal(audit.actor_id, otherActor.actorId);
  await result(
    await adminAction(
      request("/api/admin/actions", cookie, {
        action: "resetFixtures",
        input: { confirmed: true },
      }),
    ),
  );
  const [resetAudit] =
    await sql`SELECT actor_id, visitor_id, acting_view, origin FROM audit_events WHERE event_type = 'fixture_reset_completed' AND visitor_id = ${actor.visitorId} ORDER BY created_at DESC LIMIT 1`;
  assert.ok(resetAudit, "the demo reset records its initiating session");
  assert.equal(resetAudit.actor_id, actor.actorId);
  assert.equal(resetAudit.acting_view, "administrator");
  assert.equal(resetAudit.origin, "live");
  for (let attempt = 0; attempt < 29; attempt++) {
    const response = await enter(
      request("/api/session", "", { code: "incorrect-attempt" }),
    );
    assert.ok([401, 429].includes(response.status));
  }
  await result(
    await enter(
      request("/api/session", "", { code: process.env.DEMO_ACCESS_CODE }),
    ),
    429,
  );
  console.log(
    "API integration passed: signed gate, real actor attribution, private work, submission, saved answer, revision return, stale-edit protection, and persistent gate throttling.",
  );
} finally {
  await sql.end();
}
