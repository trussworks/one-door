// Test Git sandboxes use isolated configuration and never the real SSH agent.
const inheritedNames = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "NODE_ENV",
  "NO_COLOR",
  "FORCE_COLOR",
  "npm_execpath",
  "npm_node_execpath",
  "VITEST",
  "ONE_DOOR_AWS",
  "ONE_DOOR_DOCKER",
  "ONE_DOOR_TERRAFORM",
]);

export function unitEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        inheritedNames.has(name) ||
        name.startsWith("VITEST_") ||
        name.startsWith("TINYPOOL_"),
    ),
  );
}
