import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  authenticatedVisitor,
  equalSecret,
  HttpError,
  setSessionCookies,
  signCookie,
  verifyCookie,
} from "../src/server/auth.ts";
import { handle, readJson } from "../src/server/http.ts";

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
  vi.stubEnv("DEMO_ACCESS_CODE", randomBytes(16).toString("hex"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("rejects unsigned, altered, expired, and wrong-purpose cookies", () => {
  const visitor = randomUUID();
  const signed = signCookie(visitor, "access", 60);
  expect(verifyCookie(signed, "access")).toBe(visitor);
  expect(verifyCookie(signed + "x", "access")).toBeNull();
  expect(verifyCookie(signCookie(visitor, "visitor", 60), "access")).toBeNull();
  expect(verifyCookie(signCookie(visitor, "access", -60), "access")).toBeNull();
  expect(verifyCookie(undefined, "access")).toBeNull();
  expect(equalSecret("a", "longer")).toBe(false);
});

it("requires access and scopes it to the signed visitor", () => {
  expect(() =>
    authenticatedVisitor(new Request("https://demo.example/api/work")),
  ).toThrow(HttpError);
  const id = randomUUID();
  const req = new Request("https://demo.example/api/work", {
    headers: { Cookie: "od_access=" + signCookie(id, "access", 60) },
  });
  expect(authenticatedVisitor(req).visitorId).toBe(id);
  const response = new Response();
  vi.stubEnv("NODE_ENV", "production");
  setSessionCookies(response, id);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(
    response.headers
      .getSetCookie()
      .every((c) => c.includes("HttpOnly") && c.includes("Secure")),
  ).toBe(true);
});

function jsonRequest(body: string, origin = "https://demo.example") {
  return new Request("https://demo.example/api/drafts", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body,
  });
}

it("validates same-origin bounded JSON before parsing", async () => {
  await expect(readJson(jsonRequest('{"title":"A request"}'))).resolves.toEqual(
    { title: "A request" },
  );
  await expect(
    readJson(jsonRequest("{}", "https://unrelated.example")),
  ).rejects.toMatchObject({ code: "ORIGIN_MISMATCH" });
  await expect(readJson(jsonRequest("{"))).rejects.toMatchObject({
    code: "JSON_MALFORMED",
  });
  await expect(readJson(jsonRequest("x".repeat(65537)))).rejects.toMatchObject({
    code: "BODY_TOO_LARGE",
  });
});

it("uses the actual Host when NextRequest normalizes a loopback URL", async () => {
  const req = new NextRequest("http://127.0.0.1:4180/api/session", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:4180",
      Origin: "http://127.0.0.1:4180",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(new URL(req.url).hostname).toBe("localhost");
  await expect(readJson(req)).resolves.toEqual({});
});

it("uses the pinned public origin without trusting forwarded headers", async () => {
  vi.stubEnv("APP_ORIGIN", "https://one-door.example.org");
  const req = new Request("http://localhost:3000/api/session", {
    method: "POST",
    body: "{}",
    headers: {
      Host: "localhost:3000",
      "X-Forwarded-Host": "unrelated.example",
      Origin: "https://one-door.example.org",
      "Content-Type": "application/json",
    },
  });
  await expect(readJson(req)).resolves.toEqual({});
  await expect(
    readJson(jsonRequest("{}", "https://unrelated.example")),
  ).rejects.toMatchObject({ code: "ORIGIN_MISMATCH" });
});

it("returns stable error codes without leaking diagnostics", async () => {
  const response = await handle(async () => {
    throw new HttpError(401, "DEMO_ACCESS_REQUIRED");
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "DEMO_ACCESS_REQUIRED" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
