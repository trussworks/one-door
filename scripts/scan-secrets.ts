import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
const ts = await import("typescript").then(
  (module) => module.default,
  () => null,
);

const GIT = "/usr/bin/git";
// Resolved from this file, not the working directory, so the scanner works
// from any cwd and from a hook invoked in a subdirectory.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETLINT = join(ROOT, "node_modules/secretlint/bin/secretlint.js");
const SECRETLINT_CONFIG = join(ROOT, ".secretlintrc.json");

export interface Finding {
  path: string;
  line: number;
  rule: string;
}

interface Blob {
  label: string;
  path: string;
  content: string | null;
}

function main(argv: string[]): number {
  const mode = argv[0] ?? "--worktree";
  const rest = argv.slice(1);
  let blobs: Blob[];
  if (mode === "--staged") blobs = stagedBlobs();
  else if (mode === "--message") blobs = messageBlob(rest[0] ?? "");
  else if (mode === "--range")
    blobs = reachableBlobs(rest.length > 0 ? rest : ["HEAD"]);
  else if (mode === "--history") blobs = reachableBlobs(["--all"]);
  else blobs = worktreeBlobs();
  const findings = scanBlobs(blobs);
  if (findings.length === 0) {
    console.log(`No credentials found (${mode}).`);
    return 0;
  }
  console.error(`Credential findings (${mode}); values are not printed:`);
  for (const finding of findings)
    console.error(`  ${finding.path}:${finding.line}  ${finding.rule}`);
  return 1;
}

const KEY_WORDS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "credential",
  "api.?key",
  "access.?key",
  "access.?code",
];
// ||= and ??= assign a default, so a literal on the right is as hardcoded as
// one after a plain =.
const KEY = new RegExp(
  `["']?\\b(?:\\w*(?:${KEY_WORDS.join("|")})|token|\\w*(?:auth|access|refresh|bearer|api|oauth2?|github|gitlab|npm|session|secret|private)[_-]?token)["']?[ \\t]*(?:\\|\\||\\?\\?)?[:=][ \\t]*`,
  "gi",
);
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s"'`]+:([^@\s"'`]+)@/g;
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
/**
 * The format scripts/setup-env.ts generates. The prefix names the credential,
 * so the value is a finding on its own and needs no assignment around it.
 */
const NAMED_CREDENTIAL = /\bod_(?:db|demo|session)_[A-Za-z0-9_-]{24,}/g;

const REFERENCE = /^\$|^<|^process\.env\.|^import\.meta|^\{\{/;
/**
 * A sanitized blob carries a redaction marker where a value was removed. The
 * whole value must be the marker: a marker with entropy appended is a real
 * value that happens to start with the word.
 */
const REDACTION = /^(?:REDACTED|\[REDACTED\]|<REDACTED>)$/i;
const ARN = /\barn:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[\w:/+=,.@-]+/g;

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
// Encoded credentials may start with a slash; exempt only whole ordinary paths.
const PATH_VALUE = /^(?:\/|\.{1,2}\/|~\/)[\w./-]+$/;
// Real credentials use the base64 and URL-safe alphabets, so the class covers
// "/", "+", "=" and "." rather than word characters alone.
const BARE_VALUE = /^[\w@./+=-]{6,}$/;

function quotedLiteral(inner: string): boolean {
  // An interpolated string is assembled at run time, so its fixed text is a
  // prefix around the value rather than the value itself.
  if (inner.includes("${")) return false;
  if (REDACTION.test(inner)) return false;
  return inner.length >= 6 && !REFERENCE.test(inner);
}

function bareLiteral(value: string): boolean {
  const bare = value.match(/^[^\s,;)\]}"'`]+/);
  if (!bare || PATH_VALUE.test(bare[0])) return false;
  // A bracketed marker loses its closing bracket to the character class above,
  // so the marker test runs against the whole value as well.
  if (REDACTION.test(bare[0]) || REDACTION.test(value)) return false;
  return BARE_VALUE.test(bare[0]);
}

function isLiteral(rest: string, path: string): boolean {
  const value = rest.trim();
  if (value === "") return false;
  if (REFERENCE.test(value)) return false;
  const quoted = value.match(/^(["'`])(.*?)\1/);
  if (quoted) return quotedLiteral(quoted[2].trim());
  // In code an unquoted value is an identifier, a type or a property access,
  // never a credential; requiring quotes there removes that whole class.
  if (CODE_FILE.test(path)) return false;
  return bareLiteral(value);
}

/**
 * The password inside a credential URL is a literal wherever it appears, so
 * the quoting rule that code files get must not apply to it.
 */
function isUrlSecret(password: string): boolean {
  return (
    password !== "" && !REFERENCE.test(password) && !REDACTION.test(password)
  );
}

function literalsIn(text: string) {
  if (!ts) return [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    text,
  );
  const literals: Array<{ start: number; end: number; value: string }> = [];
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token === ts.SyntaxKind.StringLiteral ||
      token === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    )
      literals.push({
        start: scanner.getTokenPos(),
        end: scanner.getTextPos(),
        value: scanner.getTokenValue(),
      });
  }
  return literals;
}

function hasAssignment(
  path: string,
  line: string,
  literals: ReturnType<typeof literalsIn>,
) {
  const references = [...line.matchAll(ARN)];
  return [...line.matchAll(KEY)].some((match) => {
    if (
      references.some(
        (arn) =>
          match.index >= arn.index && match.index < arn.index + arn[0].length,
      )
    )
      return false;
    if (
      literals.some(
        (literal) => match.index > literal.start && match.index < literal.end,
      )
    )
      return false;
    return isLiteral(line.slice(match.index + match[0].length), path);
  });
}

function isCode(text: string) {
  if (!ts) return false;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    text,
  );
  let first = scanner.scan();
  if (first === ts.SyntaxKind.ExportKeyword) first = scanner.scan();
  const declaration = [
    ts.SyntaxKind.ConstKeyword,
    ts.SyntaxKind.LetKeyword,
    ts.SyntaxKind.VarKeyword,
    ts.SyntaxKind.ImportKeyword,
    ts.SyntaxKind.FunctionKeyword,
    ts.SyntaxKind.ClassKeyword,
    ts.SyntaxKind.InterfaceKeyword,
    ts.SyntaxKind.TypeKeyword,
  ].includes(first);
  const call = /^\s*(?:await\s+)?[A-Za-z_$][\w.$]*\s*\(/.test(text);
  const expression = /^\s*(?:\(|async\b|export\s+default\b)/.test(text);
  if (!declaration && !call && !expression) return false;
  const output = ts.transpileModule(text, {
    fileName: "embedded.ts",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  return !output.diagnostics?.some(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
}

function scanLines(path: string, text: string, depth = 0): Finding[] {
  const findings: Finding[] = [];
  let context = path;
  if (depth > 0) context = isCode(text) ? "embedded.ts" : "embedded.txt";
  text.split("\n").forEach((line, index) => {
    const literals = literalsIn(line);
    if (hasAssignment(context, line, literals))
      findings.push({
        path,
        line: index + 1,
        rule: "credential-assignment",
      });
    for (const match of line.matchAll(CREDENTIAL_URL)) {
      if (!isUrlSecret(match[1])) continue;
      findings.push({ path, line: index + 1, rule: "credential-url" });
    }
    const named = line.match(NAMED_CREDENTIAL)?.length ?? 0;
    for (let count = 0; count < named; count += 1)
      findings.push({ path, line: index + 1, rule: "named-credential" });
    for (const literal of literals) {
      if (depth >= 16) {
        findings.push({ path, line: index + 1, rule: "encoding-depth" });
        continue;
      }
      for (const finding of scanLines(path, literal.value, depth + 1))
        findings.push({ ...finding, line: index + 1 });
    }
  });
  return [
    ...new Map(
      findings.map((finding) => [finding.line + ":" + finding.rule, finding]),
    ).values(),
  ];
}

/**
 * Content is scanned as text and again after decoding each base64 run, so a
 * credential inside an encoded payload is examined rather than skipped.
 */
export function scanText(path: string, text: string): Finding[] {
  if (!ts) return [{ path, line: 0, rule: "parser-unavailable" }];
  const findings = scanLines(path, text);
  for (const run of text.match(BASE64_RUN) ?? []) {
    let decoded: string;
    try {
      decoded = Buffer.from(run, "base64").toString("latin1");
    } catch {
      continue;
    }
    if (!/[ -~]{8,}/.test(decoded)) continue;
    for (const finding of scanLines("decoded.txt", decoded))
      findings.push({ ...finding, path, rule: `${finding.rule}-encoded` });
  }
  return findings;
}

export function git(args: string[]): string {
  return execFileSync(GIT, args, { encoding: "utf8", maxBuffer: 1e9 });
}

function gitBuffer(args: string[]): Buffer {
  return execFileSync(GIT, args, { maxBuffer: 1e9 });
}

function stagedBlobs(): Blob[] {
  const paths = git(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
    .split("\n")
    .filter(Boolean);
  return paths.map((path) => {
    try {
      const content = gitBuffer(["show", `:${path}`]).toString("latin1");
      return { label: path, path, content };
    } catch {
      return { label: path, path, content: null };
    }
  });
}

/** A commit and a tag carry their message after the first empty line. */
function messageOf(text: string): string {
  const separator = text.indexOf("\n\n");
  return separator < 0 ? "" : text.slice(separator + 2);
}

/**
 * A blob is read whole. A commit and a tag are read for their message, because
 * a credential typed into a message is published the same as one in a file. A
 * tree carries no text of its own and returns null.
 */
function objectBlob(sha: string, path: string): Blob | null {
  let type: string;
  try {
    type = git(["cat-file", "-t", sha]).trim();
  } catch {
    return { label: `${sha.slice(0, 12)}:${path}`, path, content: null };
  }
  if (type === "tree") return null;
  const message = type === "commit" || type === "tag";
  const name = message ? `(${type} message)` : path;
  const label = `${sha.slice(0, 12)}:${name}`;
  try {
    const text = gitBuffer(["cat-file", "-p", sha]).toString("latin1");
    // A message is prose, so it is read under a name that is not code.
    return {
      label,
      path: message ? "COMMIT_EDITMSG" : path,
      content: message ? messageOf(text) : text,
    };
  } catch {
    return { label, path, content: null };
  }
}

/**
 * rev-list --objects enumerates every reachable object, including one a merge
 * commit introduces, which a per-commit diff-tree omits. A commit prints with
 * no name and a tag prints with one.
 */
function reachableBlobs(revs: string[]): Blob[] {
  let listing: string;
  try {
    listing = git(["rev-list", "--objects", ...revs]);
  } catch {
    return [{ label: revs.join(" "), path: "(rev-list)", content: null }];
  }
  const blobs: Blob[] = [];
  const seen = new Set<string>();
  for (const line of listing.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    const sha = space < 0 ? line : line.slice(0, space);
    if (seen.has(sha)) continue;
    seen.add(sha);
    const blob = objectBlob(sha, space < 0 ? "" : line.slice(space + 1));
    if (blob) blobs.push(blob);
  }
  return blobs;
}

function worktreeBlobs(): Blob[] {
  const paths = git(["ls-files"]).split("\n").filter(Boolean);
  return paths.map((path) => {
    try {
      return {
        label: path,
        path,
        content: readFileSync(path).toString("latin1"),
      };
    } catch {
      return { label: path, path, content: null };
    }
  });
}

/**
 * secretlint runs over the bytes the mode selected, not over the checkout. A
 * sentinel file keeps the selection nonempty, because secretlint v13 treats a
 * matchless glob as a fatal error: the engine always scans something, a clean
 * result is one it actually checked, and an engine that cannot load still
 * fails against the sentinel.
 */
function secretlintBlobs(blobs: Blob[]): Finding[] {
  if (!existsSync(SECRETLINT) || !existsSync(SECRETLINT_CONFIG))
    return UNAVAILABLE;
  const readable = blobs.filter((blob) => blob.content !== null);
  const dir = mkdtempSync(join(tmpdir(), "scan-secretlint-"));
  try {
    for (const [index, blob] of readable.entries()) {
      const safe = blob.path.replace(/[^\w.-]/g, "_");
      const target = join(dir, `${index}-${safe}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blob.content ?? "", "latin1");
    }
    writeFileSync(
      join(dir, ".secretlintrc.json"),
      readFileSync(SECRETLINT_CONFIG),
    );
    writeFileSync(join(dir, "scan-sentinel.txt"), "secret scan sentinel\n");
    return runSecretlint(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNAVAILABLE: Finding[] = [
  { path: "(secretlint)", line: 0, rule: "secretlint-unavailable" },
];

/**
 * The JSON report is one entry per scanned file, and each entry embeds the
 * file's raw bytes as sourceContent. Take only the validated location and
 * rule fields, relativize paths against the temporary directory, and never
 * echo a path outside it.
 */
function jsonFindings(stdout: string, dir: string): Finding[] | null {
  // The engine reports resolved paths, so /var/... may come back /private/var/...
  const prefixes = [dir];
  try {
    prefixes.push(realpathSync(dir));
  } catch {
    // A nonexistent directory has no resolved form; the literal prefix stands.
  }
  let entries: unknown;
  try {
    entries = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const findings: Finding[] = [];
  for (const entry of entries) {
    const parsed = entryFindings(entry, prefixes);
    if (parsed === null) return null;
    findings.push(...parsed);
  }
  return findings;
}

function entryFindings(entry: unknown, prefixes: string[]): Finding[] | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { filePath, messages } = entry as Record<string, unknown>;
  if (typeof filePath !== "string" || !Array.isArray(messages)) return null;
  const prefix = prefixes.find((p) => filePath.startsWith(p + "/"));
  const path = prefix
    ? filePath.slice(prefix.length).replace(/^\//, "")
    : "(secretlint)";
  const findings: Finding[] = [];
  for (const message of messages) {
    const finding = messageFinding(message, path);
    if (finding === null) return null;
    findings.push(finding);
  }
  return findings;
}

function messageFinding(message: unknown, path: string): Finding | null {
  if (typeof message !== "object" || message === null) return null;
  const { messageId, ruleId, loc } = message as {
    messageId?: unknown;
    ruleId?: unknown;
    loc?: { start?: { line?: unknown } };
  };
  const line = loc?.start?.line;
  if (!Number.isInteger(line)) return null;
  let rule = "";
  if (typeof messageId === "string" && messageId) rule = messageId;
  else if (typeof ruleId === "string") rule = ruleId;
  return {
    path,
    line: line as number,
    rule: rule ? "secretlint:" + rule : "secretlint",
  };
}

export function runSecretlint(dir: string): Finding[] {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(
      process.execPath,
      [SECRETLINT, "--maskSecrets", "--format", "json", "**/*"],
      {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: 1e9,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return UNAVAILABLE;
  }
  if (result.status === 0 && !result.error) return [];
  const stdout = result.stdout ?? "";
  // Only stderr can prove a loading failure: the JSON report on stdout embeds
  // scanned file bytes, which may themselves contain these phrases.
  if (
    /loading errors|is not found|Cannot find module/.test(result.stderr ?? "")
  )
    return UNAVAILABLE;
  const findings = jsonFindings(stdout, dir) ?? [];
  return findings.length > 0
    ? findings
    : [{ path: "(secretlint)", line: 0, rule: "secretlint" }];
}

function scanBlobs(blobs: Blob[]): Finding[] {
  const findings: Finding[] = [];
  for (const blob of blobs) {
    if (blob.content === null) {
      findings.push({ path: blob.label, line: 0, rule: "unreadable" });
      continue;
    }
    for (const finding of scanText(blob.path, blob.content))
      findings.push({ ...finding, path: blob.label });
  }
  return [...findings, ...secretlintBlobs(blobs)];
}

/**
 * The one gate every caller uses for objects already in the object database.
 * A second implementation would drift from this one and pass what it misses.
 */
export function scanRevisions(revs: string[]): Finding[] {
  return scanBlobs(reachableBlobs(revs));
}

/** The message file git hands the commit-msg hook, before the commit exists. */
function messageBlob(file: string): Blob[] {
  try {
    return [
      {
        label: "(commit message)",
        path: "COMMIT_EDITMSG",
        content: readFileSync(file).toString("latin1"),
      },
    ];
  } catch {
    return [{ label: "(commit message)", path: file, content: null }];
  }
}

if (isMain(import.meta)) process.exit(main(process.argv.slice(2)));
