import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: root });

async function a11yMessages(source: string) {
  const [result] = await eslint.lintText(source, {
    filePath: path.join(root, "src", "ui", "a11y-lint-probe.tsx"),
  });
  return result.messages.filter((m) => m.ruleId?.startsWith("jsx-a11y/"));
}

it("rejects an image without alternative text and accepts one with it", async () => {
  const bad = await a11yMessages(
    'export const Probe = () => <img src="/chart.png" />;\n',
  );
  expect(bad.map((m) => m.ruleId)).toContain("jsx-a11y/alt-text");
  expect(bad.every((m) => m.severity === 2)).toBe(true);
  const good = await a11yMessages(
    'export const Probe = () => <img src="/chart.png" alt="Monthly totals" />;\n',
  );
  expect(good).toEqual([]);
});

it("rejects a click handler on a static element and accepts a button", async () => {
  const bad = await a11yMessages(
    "export const Probe = ({ act }: { act: () => void }) => <div onClick={act} />;\n",
  );
  expect(bad.map((m) => m.ruleId)).toContain(
    "jsx-a11y/click-events-have-key-events",
  );
  const good = await a11yMessages(
    'export const Probe = ({ act }: { act: () => void }) => <button type="button" onClick={act}>Go</button>;\n',
  );
  expect(good).toEqual([]);
});

// The components mapping must make wrapper components carry their element's
// rules; an unmapped custom component stays invisible to jsx-a11y.
it("applies label rules to the Label wrapper through the component mapping", async () => {
  const declaration =
    "declare function Label(props: { htmlFor?: string; children?: unknown }): null;\n";
  const bad = await a11yMessages(
    declaration + "export const Probe = () => <Label>Name</Label>;\n",
  );
  expect(bad.map((m) => m.ruleId)).toContain(
    "jsx-a11y/label-has-associated-control",
  );
  const good = await a11yMessages(
    declaration +
      'export const Probe = () => <Label htmlFor="name">Name</Label>;\n',
  );
  expect(good).toEqual([]);
  const unmapped = await a11yMessages(
    "declare function Chip(props: { children?: unknown }): null;\n" +
      "export const Probe = () => <Chip>Name</Chip>;\n",
  );
  expect(unmapped).toEqual([]);
});

// The two option adjustments must stay narrow: each accepts only its
// documented pattern and still rejects the neighbouring misuse.
it("accepts role=list on ul but still rejects other redundant roles", async () => {
  expect(
    await a11yMessages('export const Probe = () => <ul role="list" />;\n'),
  ).toEqual([]);
  const stillBad = await a11yMessages(
    'export const Probe = () => <ol role="list" />;\n',
  );
  expect(stillBad.map((m) => m.ruleId)).toContain(
    "jsx-a11y/no-redundant-roles",
  );
});

it("accepts a labeled focusable region but still rejects bare tabIndex", async () => {
  expect(
    await a11yMessages(
      'export const Probe = () => <div tabIndex={0} role="region" aria-label="Notes" />;\n',
    ),
  ).toEqual([]);
  const stillBad = await a11yMessages(
    "export const Probe = () => <div tabIndex={0} />;\n",
  );
  expect(stillBad.map((m) => m.ruleId)).toContain(
    "jsx-a11y/no-noninteractive-tabindex",
  );
});
