import { createHash } from "node:crypto";

export const SEED_NOW = "2026-09-02T12:00:00.000Z";

export function stableUuid(namespace: string, key: string): string {
  const hash = createHash("sha256").update(`${namespace}:${key}`).digest("hex");
  const hex = `${hash.slice(0, 12)}5${hash.slice(13, 16)}a${hash.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function daysBefore(reference: string, days: number): string {
  return new Date(Date.parse(reference) - days * 86_400_000).toISOString();
}

export function minutesBefore(reference: string, minutes: number): string {
  return new Date(Date.parse(reference) - minutes * 60_000).toISOString();
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
