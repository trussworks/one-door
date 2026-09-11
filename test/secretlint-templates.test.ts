import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSecretlint } from "../scripts/scan-secrets.ts";

it("allows historical CI interpolation while detecting actual connection credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "one-door-secretlint-"));
  try {
    copyFileSync(".secretlintrc.json", join(directory, ".secretlintrc.json"));
    const templates = [
      "localhost:5432/one_door",
      "localhost:5432/one_door_e2e",
      "localhost:25432/$DATABASE_NAME",
      "host.docker.internal:5432/one_door_container",
      "host.docker.internal:25432/one_door_container",
      "localhost:25432/one_door_shutdown",
      "host.docker.internal:25432/one_door_shutdown",
    ];
    const connection = (password: string, endpoint: string) =>
      "postgresql://one_door:" + password + "@" + endpoint;
    const command = (url: string) =>
      'echo "DATABASE_URL=' + url + '" >> "$GITHUB_ENV"';
    writeFileSync(
      join(directory, "workflow.txt"),
      templates
        .flatMap((endpoint) => [
          command(connection("$password", endpoint)),
          '"' + connection("$password", endpoint) + '",',
        ])
        .join("\n"),
    );
    expect(runSecretlint(directory)).toEqual([]);
    for (const password of [
      randomBytes(18).toString("hex"),
      "$password" + randomBytes(18).toString("hex"),
    ]) {
      writeFileSync(
        join(directory, "workflow.txt"),
        templates
          .map((endpoint) => command(connection(password, endpoint)))
          .join("\n"),
      );
      expect(runSecretlint(directory)).toEqual(
        templates.map((_, index) => ({
          path: "workflow.txt",
          line: index + 1,
          rule: "secretlint:PostgreSQLConnection",
        })),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
