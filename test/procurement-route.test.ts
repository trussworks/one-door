import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../src/app/procurement/route.ts";
import { signCookie } from "../src/server/auth.ts";

// SHA-256 of procurement-prototypes.html at
// colorado-procurement-relationships commit 94e2baf; the copy stays byte-exact.
const exportDigest =
  "fbc5fa97e8a944e5e96d63079aaf6d09f34955d39eb321ac1de0ff6d1f2c529f";

function request(cookie?: string) {
  return new Request(
    "http://localhost/procurement",
    cookie ? { headers: { Cookie: cookie } } : {},
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

it("serves the unchanged prototype export to a visitor with access", async () => {
  const response = await GET(
    request("od_access=" + signCookie(randomUUID(), "access", 60)),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = Buffer.from(await response.arrayBuffer());
  expect(createHash("sha256").update(body).digest("hex")).toBe(exportDigest);
});

it.each([
  ["no cookie", () => undefined],
  [
    "an altered cookie",
    () => "od_access=" + signCookie(randomUUID(), "access", 60) + "x",
  ],
  [
    "an expired cookie",
    () => "od_access=" + signCookie(randomUUID(), "access", -60),
  ],
  [
    "a cookie signed for another purpose",
    () => "od_access=" + signCookie(randomUUID(), "visitor", 60),
  ],
  [
    "only a visitor cookie",
    () => "od_visitor=" + signCookie(randomUUID(), "visitor", 60),
  ],
])(
  "sends a request with %s to the access page without prototype bytes",
  async (_, cookie) => {
    const response = await GET(request(cookie()));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/procurement-access");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
  },
);

it("redirects only the 401 access-required failure", async () => {
  vi.resetModules();
  vi.doMock("../src/server/auth.ts", async (importOriginal) => {
    const auth = await importOriginal<typeof import("../src/server/auth.ts")>();
    return {
      ...auth,
      authenticatedVisitor: () => {
        throw new auth.HttpError(403, "DEMO_ACCESS_REQUIRED");
      },
    };
  });
  try {
    const route = await import("../src/app/procurement/route.ts");
    const response = await route.GET(request());
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  } finally {
    vi.doUnmock("../src/server/auth.ts");
    vi.resetModules();
  }
});

it("passes a configuration failure through instead of redirecting", async () => {
  const cookie = "od_access=" + signCookie(randomUUID(), "access", 60);
  vi.stubEnv("SESSION_SECRET", "");
  const response = await GET(request(cookie));
  expect(response.status).toBe(503);
  expect(response.headers.get("location")).toBeNull();
  expect(await response.json()).toEqual({ error: "DEMO_NOT_CONFIGURED" });
});
