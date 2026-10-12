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
 * expression (a) contains `process.cwd()`, `process.env.PWD`, `__dirname`,
 * `__filename` or `import.meta.url`, (b) has a bare relative string literal
 * as its base (including an array literal joined without `path.join`), or
 * (c) carries an unresolved `|| "."` / `?? "."` fallback, is a finding.
 * Identifiers bound in the same file are expanded (bounded depth) so a path
 * laundered through one local `const` still reports.
 *
 * The callee is resolved, not spelled: each file's import and binding table
 * is read first — named imports (aliases included), namespace imports, and
 * local captures (`const wf = fs.writeFileSync`, `const { writeFileSync: wf }
 * } = fs`, `const fs = require("node:fs")`) — and a call is a write only when
 * its callee resolves to a `node:fs` import. A method that happens to share a
 * write-family name (`new Widget().mkdir(...)`) is therefore not reported,
 * and a rename cannot hide the call. The scan reads the source with comments
 * and the interiors of string, template and regex literals masked out, so a
 * write-family name named only in prose or in a string is not a site.
 *
 * Documented bounds. A target resolved through a helper function is out of
 * reach — `writeJSON(p, obj)` is the sanctioned caller-supplied-path generic
 * writer, and the same shape launders an offender past a lexical scan. A
 * bracket key held in a variable (`fs[key](...)`) and a namespace obtained
 * from a call (`(await import("node:fs")).writeFileSync`) are outside the
 * binding table. Regex literals are told from division by the preceding
 * token; an unusual expression shape can put a real literal on the wrong
 * side of that heuristic. The runtime containment tests are the other half
 * of the evidence.
 *
 * Scope: production sources only. `packages/<pkg>/src` and
 * `packages/<pkg>/scripts` for every workspace, plus the whole trees of
 * `packages/contrib`, `packages/providers` and `packages/skills` (their
 * layouts are not src-shaped). Test trees are excluded by name: a test that
 * writes into a temporary cwd is exercising the hazard this gate reports,
 * inside its own fixture.
 *
 * Allowlist: one entry per sanctioned site, keyed by file, the resolved
 * write-family callee and a regex over the expanded first argument. It holds
 * three entries in two files, all `source-dir` shapes — the generated schema
 * artifact (directory creation and write) and the workers registry's parent
 * directory. A new write anywhere else in those files matches no entry and
 * is a finding.
 *
 * Neutral by construction, so no entry is needed: a caller-supplied path
 * argument, `os.tmpdir()` scratch, an absolute path literal, and a target
 * that resolves through a helper function (the documented bound above).
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

/** Modules whose imports can resolve a write-family callee. */
const FS_MODULES = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"]);

/** `open`/`openSync` are writes only when the mode is not a read mode. */
const OPEN_CALLS = new Set(["open", "openSync"]);
const READ_MODES = new Set(["r", "rs", "sr"]);

/**
 * Allowlisted sites: file + resolved callee + a regex over the expanded first
 * argument + reason, one entry per sanctioned call. Keyed to the call, not
 * the file, so a new write in an allowlisted file matches nothing and is a
 * finding.
 */
const ALLOWLIST = [
  {
    file: "packages/core/scripts/gen-braid-schema.mjs",
    callee: "mkdirSync",
    firstArg: /braid\.schema\.json/,
    reason:
      "creates the directory of the generated braid schema artifact, which check-braid-schema.mjs owns and pins",
  },
  {
    file: "packages/core/scripts/gen-braid-schema.mjs",
    callee: "writeFileSync",
    firstArg: /braid\.schema\.json/,
    reason:
      "writes the generated braid schema artifact, which check-braid-schema.mjs owns and pins",
  },
  {
    file: "packages/core/src/lib/orchestrator/workers.ts",
    callee: "mkdirSync",
    firstArg: /^dirname\(getWorkersFilePath\(/,
    reason:
      "creates the parent directory of the workers registry: getWorkersFilePath resolves under the braid root (projects/<slug>/workers.json), never the cwd — the cwd is only a slug input",
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

// ── Literal-aware masking ───────────────────────────────────────────────────

/** True when a `/` at this point starts a regex literal, not a division. */
const REGEX_AFTER = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%",
  "^", "~", "<", ">", "return", "case", "typeof", "in", "of", "do", "else",
  "delete", "void", "instanceof", "yield", "await", "new", "throw",
]);

/** End index of the string literal starting at `start` (escapes respected). */
function skipStringLiteral(text, start) {
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

/** End index of the regex literal starting at `start` (character classes respected). */
function skipRegexLiteral(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return i;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i++;
      while (i < text.length && /[a-z]/i.test(text[i])) i++;
      return i;
    }
    i++;
  }
  return text.length;
}

/** The identifier (or keyword) starting at `i`. */
function readWord(text, i, to = text.length) {
  const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, Math.min(to, i + 64)));
  return m ? m[0] : text[i];
}

/** End index of the template literal starting at `start` (nested `${}` respected). */
function skipTemplateLiteral(text, start, to) {
  let i = start + 1;
  while (i < to) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") return i + 1;
    if (text[i] === "$" && text[i + 1] === "{") {
      i = findTemplateExprEnd(text, i + 2, to) + 1;
      continue;
    }
    i++;
  }
  return to;
}

/** Index of the `}` closing the template expression opened at `from`. */
function findTemplateExprEnd(text, from, to) {
  let depth = 0;
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === "`") {
      i = skipTemplateLiteral(text, i, to);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return to;
}

/**
 * Blank out comments and the interiors of string, template and regex
 * literals, preserving offsets (and newlines). `isCode[i]` marks the
 * positions that are real code, so binding-table regexes can run over the
 * original text and still ignore prose.
 */
function maskNonCode(text) {
  const out = text.split("");
  const isCode = new Array(text.length).fill(true);
  const blank = (from, to, code) => {
    for (let k = Math.max(0, from); k < Math.min(to, text.length); k++) {
      if (out[k] !== "\n") out[k] = " ";
      isCode[k] = code;
    }
  };
  let prev = "";
  const scan = (from, to) => {
    let i = from;
    while (i < to) {
      const ch = text[i];
      if (ch === "/" && text[i + 1] === "/") {
        const nl = text.indexOf("\n", i);
        const end = nl === -1 || nl > to ? to : nl;
        blank(i, end, false);
        i = end;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        const end = close === -1 ? to : Math.min(to, close + 2);
        blank(i, end, false);
        i = end;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const end = skipStringLiteral(text, i);
        blank(i + 1, end - 1, false);
        i = end;
        prev = '"';
        continue;
      }
      if (ch === "`") {
        let j = i + 1;
        // The backticks stay (a quoted bracket key must still read as a
        // quoted key); only the body and the interpolation delimiters blank.
        while (j < to) {
          if (text[j] === "\\") {
            blank(j, j + 2, false);
            j += 2;
            continue;
          }
          if (text[j] === "`") {
            j += 1;
            break;
          }
          if (text[j] === "$" && text[j + 1] === "{") {
            blank(j, j + 2, false);
            const close = findTemplateExprEnd(text, j + 2, to);
            scan(j + 2, close);
            blank(close, close + 1, false);
            j = close + 1;
            continue;
          }
          blank(j, j + 1, false);
          j += 1;
        }
        i = j;
        prev = "`";
        continue;
      }
      if (ch === "/" && REGEX_AFTER.has(prev)) {
        const end = skipRegexLiteral(text, i);
        blank(i, end, false);
        i = end;
        prev = "/";
        continue;
      }
      if (!/\s/.test(ch)) prev = /[A-Za-z_$]/.test(ch) ? readWord(text, i, to) : ch;
      i++;
    }
  };
  scan(0, text.length);
  return { masked: out.join(""), isCode };
}

// ── Callee resolution ───────────────────────────────────────────────────────

/**
 * The file's fs binding table: local names bound to an fs module (namespace
 * or default import) and local names bound to a write-family function.
 * Imports, `require` calls and local captures are all read; captures are
 * resolved to a fixpoint (bounded) so `const a = fs; const wf = a.mkdir`
 * still lands.
 */
function fsBindings(text, isCode) {
  const namespaces = new Set();
  const writes = new Map();

  const each = (re, fn) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (isCode[m.index]) fn(m);
    }
  };
  const specifiers = (list, separator) => {
    const out = [];
    for (const spec of list.split(",")) {
      const parts = spec
        .trim()
        .split(separator)
        .map((s) => s.trim());
      if (parts[0]) out.push(parts);
    }
    return out;
  };

  each(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g, (m) => {
    if (FS_MODULES.has(m[2])) namespaces.add(m[1]);
  });
  each(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g, (m) => {
    if (FS_MODULES.has(m[2])) namespaces.add(m[1]);
  });
  each(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g, (m) => {
    if (!FS_MODULES.has(m[2])) return;
    for (const [imported, local] of specifiers(m[1], /\s+as\s+/)) {
      if (imported === "promises") namespaces.add(local ?? "promises");
      else if (WRITE_CALLS.includes(imported)) writes.set(local ?? imported, imported);
    }
  });
  each(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g, (m) => {
    if (FS_MODULES.has(m[2])) namespaces.add(m[1]);
  });
  each(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g, (m) => {
    if (!FS_MODULES.has(m[2])) return;
    for (const [imported, local] of specifiers(m[1], /\s*:\s*/)) {
      if (WRITE_CALLS.includes(imported)) writes.set(local ?? imported, imported);
    }
  });

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    each(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*[;\n]/g,
      (m) => {
        const local = m[1];
        const chain = m[2].split(/\s*\.\s*/);
        const add = (set, value) => {
          if (!set.has(value)) {
            set.add(value);
            changed = true;
          }
        };
        if (chain.length === 1) {
          const target = writes.get(chain[0]);
          if (target && !writes.has(local)) {
            writes.set(local, target);
            changed = true;
          }
          if (namespaces.has(chain[0])) add(namespaces, local);
        } else if (chain.length === 2) {
          const [obj, prop] = chain;
          if (namespaces.has(obj) && prop === "promises") add(namespaces, local);
          if (namespaces.has(obj) && WRITE_CALLS.includes(prop) && !writes.has(local)) {
            writes.set(local, prop);
            changed = true;
          }
        } else if (chain.length === 3 && chain[1] === "promises") {
          const [obj, , prop] = chain;
          if (namespaces.has(obj) && WRITE_CALLS.includes(prop) && !writes.has(local)) {
            writes.set(local, prop);
            changed = true;
          }
        }
      },
    );
    each(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\s*[;\n]/g, (m) => {
      if (!namespaces.has(m[2])) return;
      for (const [prop, local] of specifiers(m[1], /\s*:\s*/)) {
        if (prop === "promises") {
          const name = local ?? prop;
          if (!namespaces.has(name)) {
            namespaces.add(name);
            changed = true;
          }
          continue;
        }
        const name = local ?? prop;
        if (WRITE_CALLS.includes(prop) && !writes.has(name)) {
          writes.set(name, prop);
          changed = true;
        }
      }
    });
    if (!changed) break;
  }
  return { namespaces, writes };
}

/** True when `object` names an fs namespace (or `<ns>.promises`). */
function isFsNamespace(object, table) {
  const o = object.trim();
  if (table.namespaces.has(o)) return true;
  const m = /^(.*)\.\s*promises$/.exec(o);
  return m !== null && table.namespaces.has(m[1].trim());
}

/**
 * The canonical write-family name the callee at `chainStart` resolves to, or
 * null. `chain` is the masked callee text; its key is read from `original` at
 * the same offsets (masking preserves them).
 */
function resolveCallee(chain, chainStart, original, table) {
  const chainText = original
    .slice(chainStart, chainStart + chain.length)
    .replace(/\?\./g, ".");
  const bracket = /^(.*?)\[\s*(["'`])([\s\S]*?)\2\s*\]$/.exec(chainText);
  if (bracket) {
    const object = bracket[1].trim();
    const prop = bracket[3];
    return isFsNamespace(object, table) && WRITE_CALLS.includes(prop) ? prop : null;
  }
  const member = /^(.*)\.\s*([A-Za-z_$][\w$]*)$/.exec(chainText);
  if (member) {
    const object = member[1].trim();
    const prop = member[2];
    return isFsNamespace(object, table) && WRITE_CALLS.includes(prop) ? prop : null;
  }
  return table.writes.get(chainText.trim()) ?? null;
}

/**
 * Every call in the masked source: a member chain (dots, optional chaining
 * and quoted bracket keys) immediately followed by `(` (itself possibly
 * optional-chained), not preceded by `.` or an identifier character (so a
 * member call is read as a chain, never as its bare tail).
 */
const CALL_RE =
  /(?<![\w$.])([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[\s*["'`][^"'`]*["'`]\s*\])*)\s*(?:\?\.)?\s*\(/g;

// ── Expression reading ──────────────────────────────────────────────────────

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
      i = skipStringLiteral(text, i);
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

/** Split on depth-0 commas (literals respected). */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts;
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
      i = skipStringLiteral(text, i);
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
      const end = skipStringLiteral(expr, i);
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
  ["process.env.PWD", /\bprocess\.env\.PWD\b/],
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
    if (m) {
      const args = readArgs(e, e.indexOf("(", m.index));
      if (args.length === 0) return e;
      e = args[0].trim();
      continue;
    }
    // A relative target built without path.join: `["out", "x"].join("/")`.
    const arr = /^\[([\s\S]*)\]\s*\.\s*(?:join|concat)\s*\(/.exec(e);
    if (arr) {
      const first = splitTopLevel(arr[1])[0];
      if (first === undefined || first.trim() === "") return e;
      e = first.trim();
      continue;
    }
    break;
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
  const { masked, isCode } = maskNonCode(text);
  const bindings = fileBindings(text);
  const table = fsBindings(text, isCode);
  CALL_RE.lastIndex = 0;
  let match;
  while ((match = CALL_RE.exec(masked))) {
    const chain = match[1];
    const chainStart = match.index;
    const name = resolveCallee(chain, chainStart, text, table);
    if (name === null) continue;
    const open = chainStart + chain.length;
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
    const line = lineOf(text, chainStart);
    const entry = ALLOWLIST.find(
      (a) => a.file === file && a.callee === name && a.firstArg.test(expanded),
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
