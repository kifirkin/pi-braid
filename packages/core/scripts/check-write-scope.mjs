#!/usr/bin/env node
/**
 * check-write-scope.mjs — a production write must not resolve into the
 * session's project (the cwd) or into a path relative to it.
 *
 * Braid state belongs under the config root; the cwd is the user's project,
 * and a single write into it lands in every project a session touches. One
 * production cwd write and one `HOME || "."` fallback chain that degraded
 * into a cwd write were found by running braid, not by reading it; this check
 * makes the next one loud at commit time.
 *
 * The test is lexical, never execution: a write-family call whose target
 * expression (a) contains `process.cwd()`, `__dirname`, `__filename` or
 * `import.meta.url`, (b) has a bare relative string literal as its base, or
 * (c) carries an unresolved `|| "."` / `?? "."` fallback, is a finding.
 * Identifiers bound in the same file are expanded (bounded depth) so a path
 * laundered through one local `const` still reports. A write-family name
 * imported under an alias (`import { writeFileSync as wf } from "node:fs"`)
 * is resolved from the file's own import lines and scanned as the write it
 * is; without that, renaming the callee slipped the whole call past the scan
 * (the reviewer's plant was not even counted as a write site).
 *
 * Documented bound: a target resolved through a helper function is out of
 * reach - `writeJSON(p, obj)` is the sanctioned caller-supplied-path generic
 * writer, and the same shape launders an offender past a lexical scan. So is
 * a write-family name rebound by destructuring (`const { writeFileSync: wf }
 * = fs`): the alias pass reads import specifiers, not destructuring patterns.
 * The runtime containment tests are the other half of the evidence.
 *
 * Scope: production sources only. `packages/<pkg>/src` and
 * `packages/<pkg>/scripts` for every workspace, plus the whole trees of
 * `packages/contrib`, `packages/providers` and `packages/skills` (their
 * layouts are not src-shaped). Test trees are excluded by name: a test that
 * writes into a temporary cwd is exercising the hazard this gate reports,
 * inside its own fixture.
 *
 * Allowlist: one line per entry, naming the file, the shape it sanctions and
 * why. The sanctioned shapes are the session directory, `os.tmpdir()`, a
 * caller-supplied path generic writer, a repo file a drift check owns (the
 * generated schema), and pi's own project settings path where it is read.
 * Anything else is a finding.
 *
 * Usage: node packages/core/scripts/check-write-scope.mjs
 * Exit code: 0 = clean, 1 = a write can resolve into the project.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles } from "./lib/collect-files.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script is at packages/core/scripts/ — monorepo root is 3 levels up.
const root = resolve(__dirname, "..", "..", "..");
const selfPath = resolve(fileURLToPath(import.meta.url));

const CODE_FILE = /\.(?:[cm]?[jt]s)$/;
/** A test tree: any `test/` path segment, or a file named `test-...`/`*.test.*`. */
const TEST_PATH = /(^|\/)(?:test|tests|__tests__)\//;
const TEST_FILE = /(^|\/)test[-.]|\.(?:test|spec)\.[cm]?[jt]s$/;

/** Write-family call names. Longest first so `rm` never shadows `rmSync`. */
const WRITE_CALLS = [
  "createWriteStream",
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "renameSync",
  "unlinkSync",
  "copyFileSync",
  "copyFile",
  "writeFile",
  "appendFile",
  "rename",
  "unlink",
  "mkdir",
  "rmSync",
  "openSync",
  "cpSync",
  "cp",
  "rm",
  "open",
];

/**
 * The write-call matcher for one file: the write-family names plus any local
 * aliases its own import lines bind to them, longest name first so `rm` never
 * shadows `rmSync`.
 */
function writeCallRe(aliases) {
  const names = [...WRITE_CALLS, ...aliases.keys()];
  return new RegExp(`\\b(?:${names.join("|")})\\s*\\(`, "g");
}

/**
 * Named-import aliases of write-family names, map local name -> canonical.
 * `import { writeFileSync as wf } from "node:fs"` makes `wf(...)` the write
 * `writeFileSync(...)` is; the scan reads the import specifiers rather than
 * trusting the callee's spelling.
 */
function writeFamilyAliases(text) {
  const aliases = new Map();
  const IMPORT_RE = /\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](?:node:fs|fs)["']/g;
  let m;
  while ((m = IMPORT_RE.exec(text))) {
    for (const spec of m[1].split(",")) {
      const [imported, local] = spec
        .trim()
        .split(/\s+as\s+/)
        .map((s) => s.trim());
      if (!imported || !local || imported === local) continue;
      if (WRITE_CALLS.includes(imported)) aliases.set(local, imported);
    }
  }
  return aliases;
}

/** `open`/`openSync` are writes only when the mode is not a read mode. */
const OPEN_CALLS = new Set(["open", "openSync"]);
const READ_MODES = new Set(["r", "rs", "sr"]);

/**
 * Allowlisted sites: file + shape + reason, one line per entry. Keyed by file
 * and shape (not line) so an edit above the site cannot silently move the
 * sanction to a different write.
 */
const ALLOWLIST = [
  {
    file: "packages/core/scripts/gen-braid-schema.mjs",
    shape: "source-dir",
    reason:
      "writes the generated braid schema artifact, which check-braid-schema.mjs owns and pins",
  },
  {
    file: "packages/core/src/lib/orchestrator/workers.ts",
    shape: "source-dir",
    reason:
      "the cwd is only a slug input: getWorkersFilePath resolves under the braid root (projects/<slug>/workers.json), never the cwd",
  },
];

// ── Scanning ────────────────────────────────────────────────────────────────

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Every production root this check owns, derived, never hand-listed. */
function scanRoots() {
  const roots = new Set();
  const packagesDir = join(root, "packages");
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    for (const sub of ["src", "scripts"]) {
      const dir = join(packagesDir, entry.name, sub);
      if (isDir(dir)) roots.add(dir);
    }
  }
  // Packages whose production code is not under src/ (flat module dirs).
  for (const whole of ["contrib", "providers", "skills"]) {
    const dir = join(packagesDir, whole);
    if (isDir(dir)) roots.add(dir);
  }
  return [...roots].sort();
}

function productionFiles() {
  const files = new Set();
  for (const dir of scanRoots()) {
    for (const file of collectFiles(dir, (p) => CODE_FILE.test(p))) {
      const rel = relative(root, file);
      if (TEST_PATH.test(rel) || TEST_FILE.test(rel)) continue;
      if (resolve(file) === selfPath) continue;
      files.add(rel);
    }
  }
  return [...files].sort();
}

// ── Expression reading ──────────────────────────────────────────────────────

/** End index of the string/template literal starting at `start`. */
function skipLiteral(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

/**
 * Read the balanced argument list of a call whose `(` is at `open`. Returns
 * the raw argument strings (comma-split at depth 0, literals respected).
 */
function readArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let i = open + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteral(text, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0 && ch === ")") {
        args.push(text.slice(start, i));
        return args;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  args.push(text.slice(start));
  return args;
}

/**
 * Read a binding initializer: from `start` to the first `;` at depth 0, or to
 * the end of the line when no semicolon follows (bounded either way).
 */
function readInitializer(text, start) {
  let depth = 0;
  let i = start;
  const limit = Math.min(text.length, start + 500);
  while (i < limit) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteral(text, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) break;
    else if (ch === "\n" && depth === 0) {
      const next = text.slice(i + 1, i + 40).trimStart();
      if (next.startsWith("const ") || next.startsWith("let ")) break;
    }
    i++;
  }
  return text.slice(start, i).trim();
}

/** Local `const NAME = <expr>` bindings, for one-level path laundering. */
function fileBindings(text) {
  const bindings = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m;
  while ((m = re.exec(text))) {
    bindings.set(m[1], readInitializer(text, re.lastIndex));
  }
  return bindings;
}

/** Replace identifiers that have a local binding, bounded depth and size. */
function expand(expr, bindings, depth = 2, seen = new Set()) {
  if (depth <= 0 || expr.length > 800) return expr;
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipLiteral(expr, i);
      out += expr.slice(i, end);
      i = end;
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
    if (m && !(i > 0 && /[\w$.]/.test(expr[i - 1]))) {
      const name = m[0];
      if (bindings.has(name) && !seen.has(name)) {
        const next = new Set(seen);
        next.add(name);
        out += expand(bindings.get(name), bindings, depth - 1, next);
        i += name.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out.length > 1200 ? out.slice(0, 1200) : out;
}

// ── Shape tests ─────────────────────────────────────────────────────────────

const CWD_TOKENS = [
  ["process.cwd()", /\bprocess\.cwd\s*\(/],
  ["__dirname", /\b__dirname\b/],
  ["__filename", /\b__filename\b/],
  ["import.meta.url", /\bimport\.meta\.(?:url|dirname|filename)\b/],
];

const DOT_FALLBACK = /\|\|\s*["'`]\.\s*["'`]|\?\?\s*["'`]\.\s*["'`]/;

/** Interiors of a quoted literal, or null when `expr` is not one. */
function unquote(expr) {
  const s = expr.trim();
  if (s.length < 2) return null;
  const quote = s[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  if (s[s.length - 1] !== quote) return null;
  return s.slice(1, -1);
}

function isAbsolute(path) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** The base of a target expression: the first argument of nested joins. */
function targetBase(expr) {
  let e = expr.trim();
  for (let i = 0; i < 4; i++) {
    const m = /^(?:path\.)?(?:join|resolve)\s*\(/.exec(e);
    if (!m) break;
    const args = readArgs(e, e.indexOf("(", m.index));
    if (args.length === 0) return e;
    e = args[0].trim();
  }
  return e;
}

/**
 * The offending shape of a target expression, or null. `expanded` is the
 * expression with local bindings substituted; both are searched so a literal
 * that only looks relative after expansion is still caught.
 */
function shapeOf(raw, expanded) {
  for (const [token, re] of CWD_TOKENS) {
    if (re.test(expanded) || re.test(raw)) return { id: "source-dir", token };
  }
  if (DOT_FALLBACK.test(expanded) || DOT_FALLBACK.test(raw)) {
    return { id: "dot-fallback", token: '"" || "."' };
  }
  const inner = unquote(targetBase(expanded));
  if (inner !== null && inner !== "" && !inner.startsWith("${")) {
    if (!isAbsolute(inner)) {
      return { id: "relative-literal", token: JSON.stringify(inner) };
    }
  }
  // A leading relative literal followed by concatenation: `"x" + name`.
  const lead = unquote(expanded.trim().split(/\s*\+\s*/)[0]);
  if (
    lead !== null &&
    lead !== "" &&
    !lead.startsWith("${") &&
    !isAbsolute(lead) &&
    /^["'`][\s\S]*["'`]\s*\+/.test(expanded.trim())
  ) {
    return { id: "relative-literal", token: JSON.stringify(lead) };
  }
  return null;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

// ── Main ────────────────────────────────────────────────────────────────────

const findings = [];
const allowlisted = [];
let sites = 0;
const files = productionFiles();

for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  const bindings = fileBindings(text);
  const aliases = writeFamilyAliases(text);
  const writeRe = writeCallRe(aliases);
  let match;
  while ((match = writeRe.exec(text))) {
    const callee = match[0].slice(0, match[0].indexOf("(")).trim();
    const name = aliases.get(callee) ?? callee;
    const open = match.index + match[0].length - 1;
    const args = readArgs(text, open);
    const raw = (args[0] ?? "").trim();
    // `open(path, "r")` and `open(path)` are reads (the Node default mode).
    if (OPEN_CALLS.has(name)) {
      const mode = unquote(args[1] ?? "");
      if (mode === null || READ_MODES.has(mode)) continue;
    }
    if (!raw) continue;
    sites++;
    const expanded = expand(raw, bindings);
    const shape = shapeOf(raw, expanded);
    if (!shape) continue;
    const line = lineOf(text, match.index);
    const entry = ALLOWLIST.find(
      (a) => a.file === file && a.shape === shape.id,
    );
    if (entry) {
      allowlisted.push({ file, line, token: shape.token, reason: entry.reason });
      continue;
    }
    findings.push({ file, line, expr: raw, shape });
  }
}

if (findings.length > 0) {
  console.error(
    `check-write-scope: ${findings.length} write(s) can resolve into the project`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}: ${f.expr}`);
    console.error(`    ${f.shape.id}: ${f.shape.token}`);
  }
  console.error(
    `${files.length} production files scanned, ${sites} write sites, ${allowlisted.length} allowlisted`,
  );
  process.exit(1);
}

console.log(
  `check-write-scope: clean (${files.length} production files scanned, ${sites} write sites, ${allowlisted.length} allowlisted)`,
);
