import { afterEach, expect, it, vi } from "vitest";
import nextConfig from "../next.config";

afterEach(() => vi.unstubAllEnvs());

it("lets verification and the running demo use separate build directories", () => {
  vi.stubEnv("ONE_DOOR_BUILD_DIR", "");
  expect(nextConfig().distDir).toBe(".next");
  vi.stubEnv("ONE_DOOR_BUILD_DIR", ".next/understandability");
  expect(nextConfig().distDir).toBe(".next/understandability");
});
