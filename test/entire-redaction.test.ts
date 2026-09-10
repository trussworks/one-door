import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const settings = JSON.parse(
  readFileSync(new URL("../.entire/settings.json", import.meta.url), "utf8"),
);
const rules: Record<string, string> = settings.redaction.custom_redactions;

function pattern(name: string) {
  const source = rules[name];
  return new RegExp(
    source.replace(/^\(\?i\)/, ""),
    source.startsWith("(?i)") ? "giu" : "gu",
  );
}

function expectRedacted(actual: string, expected = "REDACTED") {
  if (actual !== expected) {
    throw new Error("Redaction did not preserve the expected text.");
  }
}

it("captures credential assignments in recorded source and remediation commands", () => {
  const value = randomBytes(24).toString("hex");
  const cases = [
    `const secret = "${value}";`,
    `43:   password: "${value}",`,
    `POSTGRES_PASSWORD: ${value}`,
    `process.env.DEMO_ACCESS_CODE ||= "${value}";`,
    `process.env.SESSION_SECRET ??= "${value}";`,
    `const secret = \\"${value}\\";`,
    `const secret = \\\\\\"${value}\\\\\\";`,
    `s/process\\.env\\.DEMO_ACCESS_CODE \\|\\|= "${value}";/replacement/`,
  ];
  for (const input of cases) {
    const matches = [
      ...input.matchAll(pattern("one_door_recorded_credential_assignment")),
    ];
    expect(matches.some((match) => match[0].includes(value))).toBe(true);
  }
  expect(
    pattern("one_door_recorded_credential_assignment").test(
      "The password rotation happened last week.",
    ),
  ).toBe(false);
});

it("retains capture protection for generated credentials and authenticated URLs", () => {
  const value = randomBytes(24).toString("hex");
  for (const purpose of ["db", "demo", "session"]) {
    expect(pattern("one_door").test(`od_${purpose}_${value}`)).toBe(true);
  }
  const input = `postgresql://reader:${value}@localhost:5432/demo`;
  const matches = [
    ...input.matchAll(pattern("one_door_recorded_credential_url")),
  ];
  expect(matches.some((match) => match[0].includes(value))).toBe(true);
  expect(
    pattern("one_door_recorded_credential_url").test(
      "https://example.com/demo",
    ),
  ).toBe(false);
});

it("redacts complete private-key blocks, including encrypted headers and quoted source", () => {
  const rule = "one_door_recorded_private_key_block";
  for (const kind of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
    const begin = ["-----BEGIN", `${kind}PRIVATE KEY-----`].join(" ");
    const end = ["-----END", `${kind}PRIVATE KEY-----`].join(" ");
    const body = [
      "Proc-Type: 4,ENCRYPTED",
      `DEK-Info: AES-256-CBC,${randomBytes(16).toString("hex")}`,
      randomBytes(48).toString("base64"),
    ];
    const block = [begin, ...body, end].join("\n");
    const quoted = JSON.stringify(block);
    const nestedQuoted = JSON.stringify(quoted);
    const redactedQuoted = quoted.replace(pattern(rule), "REDACTED");
    const redactedNested = nestedQuoted.replace(pattern(rule), "REDACTED");
    expectRedacted(
      `before ${block} after`.replace(pattern(rule), "REDACTED"),
      "before REDACTED after",
    );
    expectRedacted(JSON.parse(redactedQuoted));
    expectRedacted(JSON.parse(JSON.parse(redactedNested)));
    expect(pattern(rule).test(begin)).toBe(false);
  }
  expect(
    pattern(rule).test("-----BEGIN NOTES----- plain text -----END NOTES-----"),
  ).toBe(false);
});

it("redacts SendGrid detections without consuming surrounding text", () => {
  const keys = [
    [
      "SG",
      randomBytes(16).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ].join("."),
    ["SG", "short", "control"].join("."),
  ];
  for (const key of keys) {
    expectRedacted(
      `before ${key} after`.replace(
        pattern("one_door_recorded_sendgrid_key"),
        "REDACTED",
      ),
      "before REDACTED after",
    );
  }
  expect(pattern("one_door_recorded_sendgrid_key").test("SG.public")).toBe(
    false,
  );
});
