import { authConfiguration } from "../../../server/auth.ts";

/**
 * Process-local liveness for load-balancer replacement decisions. No
 * database dependency: a shared database outage must not make every
 * otherwise-working web task look replaceable. /api/health remains the
 * deep database readiness check.
 */
export function GET() {
  try {
    authConfiguration();
  } catch {
    return Response.json(
      { status: "unconfigured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { status: "live" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
