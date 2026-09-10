import { requireVisitor, withDb } from "../workflow/shared.ts";
import { authenticatedVisitor } from "./auth.ts";

export async function visitorContext(request: Request) {
  const context = authenticatedVisitor(request);
  const visitor = await withDb((db) => requireVisitor(db, context.visitorId));
  return { visitorId: visitor.id, actorId: visitor.actorId };
}

export async function reviewerContext(request: Request) {
  return {
    ...(await visitorContext(request)),
    actingView: "contributor" as const,
  };
}
