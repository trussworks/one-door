import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const configuration = z.object({
  SESSION_SECRET: z.string().min(32),
  DEMO_ACCESS_CODE: z.string().min(12),
});

export function authConfiguration() {
  const result = configuration.safeParse(process.env);
  if (!result.success) throw new HttpError(503, "DEMO_NOT_CONFIGURED");
  return result.data;
}

export function equalSecret(a: string, b: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const claimsSchema = z.object({
  visitorId: z.uuid(),
  kind: z.enum(["access", "visitor"]),
  expires: z.number().int(),
});

export function signCookie(
  visitorId: string,
  kind: "access" | "visitor",
  seconds: number,
) {
  const payload = Buffer.from(
    JSON.stringify({
      visitorId,
      kind,
      expires: Math.floor(Date.now() / 1000) + seconds,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", authConfiguration().SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return payload + "." + signature;
}

function visitorClaim(payload: string, kind: "access" | "visitor") {
  try {
    const parsed = claimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    if (
      !parsed.success ||
      parsed.data.kind !== kind ||
      parsed.data.expires <= Date.now() / 1000
    )
      return null;
    return parsed.data.visitorId;
  } catch {
    return null;
  }
}

export function verifyCookie(
  value: string | undefined,
  kind: "access" | "visitor",
) {
  if (!value || value.length > 1000) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", authConfiguration().SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  if (!equalSecret(signature, expected)) return null;
  return visitorClaim(payload, kind);
}

export function cookieValue(request: Request, name: string) {
  const pair = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + "="));
  return pair?.slice(name.length + 1);
}

export function authenticatedVisitor(request: Request) {
  const visitorId = verifyCookie(cookieValue(request, "od_access"), "access");
  if (!visitorId) throw new HttpError(401, "DEMO_ACCESS_REQUIRED");
  return { visitorId };
}

export function setSessionCookies(response: Response, visitorId: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  for (const [kind, lifetime] of [
    ["access", 28800],
    ["visitor", 31536000],
  ] as const) {
    const value = signCookie(visitorId, kind, lifetime);
    response.headers.append(
      "Set-Cookie",
      `od_${kind}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetime}${secure}`,
    );
  }
}
