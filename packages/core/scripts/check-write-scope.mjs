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
 * as its base (including an array literal joined without `path.join`, and a
 * template whose leading interpolation is itself a relative literal —
 * `` `${'.'}/p11.json` `` bases at `./p11.json`), or (c) carries an
 * unresolved `|| "."` / `?? "."` fallback, is a finding.
 * Identifiers bound in the same file are expanded (bounded depth) so a path
 * laundered through one local `const` still reports.
 *
 * The callee is resolved, not spelled: each file's import and binding table
 * is read first — named imports (aliases included) from any spelling of the
 * module (`node:fs`, `fs`, `node:fs/promises`, `fs/promises`), namespace
 * imports, `require` calls, TypeScript's `import fs = require("node:fs")`,
 * local captures and assignments (`const wf = fs.writeFileSync`,
 * `let wf; wf = fs.writeFileSync`, `const wf = fs.writeFileSync.bind(fs)`, the
 * second declarator of `const wf = …, md = fs.mkdirSync`, and
 * `const { writeFileSync: wf } = fs` or `= fs.promises`), bindings taken from
 * a dynamic import (`const { writeFile: wf } = await import("node:fs/promises")`),
 * and a write-family name re-exported from a scanned local module
 * (`import { wf } from "./shim.mjs"`, following `export { … as wf }` and
 * `export const wf = …` one hop at a time) — and a call is a write only when
 * its callee resolves to a `node:fs` import. A method that happens to share a
 * write-family name (`new Widget().mkdir(...)`) is therefore not reported,
 * and a rename cannot hide the call. The scan reads the source with comments
 * and the interiors of string, template and regex literals masked out, so a
 * write-family name named only in prose or in a string is not a site; a `}`
 * inside a comment, a string or a regex cannot close a template interpolation,
 * and the token before a `/` is read whole, so `return /['"]/` is a regex
 * while `o.in / 2` stays a division.
 *
 * Documented bounds. A target resolved through a helper function is out of
 * reach — `writeJSON(p, obj)` is the sanctioned caller-supplied-path generic
 * writer, and the same shape launders an offender past a lexical scan. A
 * callee the binding table cannot name is out of reach too, always in the
 * fail-open direction: a bracket key that is not a plain quoted literal
 * (`fs[key](...)`, `fs["write" + "FileSync"](...)`), an fs namespace obtained
 * inline from a call (`require("node:fs").writeFileSync`,
 * `(await import("node:fs")).writeFileSync`), a write invoked through
 * `Function.prototype` (`writeFileSync.call(…)`), a write-family name a local
 * module re-exports wholesale (`export * from "node:fs"` — the named forms are
 * followed), and an import specifier that resolves to no scanned file (a path
 * alias, or a module outside the scan roots; a relative specifier carrying a
 * `.js`, `.mjs`, `.cjs` or `.jsx` extension is also tried as its TypeScript
 * twin, so a source import spelled `./x.js` names a scanned `x.ts`).
 * Shell-mediated writes are out of scope by construction:
 * `execSync(`mkdir -p "${dir}"`)` is a string and
 * `execSync("rm -f ./state.json")` is not a write-family call; the packages'
 * own containment tests are the net for those writers. A target whose base is
 * genuinely dynamic — a template that starts at an interpolation the gate
 * cannot read as a literal, such as `` `${os.tmpdir()}/x` `` or
 * `` `${file}.tmp` `` where `file` is a local binding — is left alone: reading
 * it would need evaluation, not lexing. A name declared more than once in one
 * file is read as its LAST declaration, so a call site bound to an earlier
 * one is judged against the later target (`const dir = process.cwd()` in one
 * function, `const dir = pinnedDir()` at the file's end, `mkdirSync(dir)` is
 * judged as the pinned one): the binding table is per file, not per scope. Regex literals are told from division
 * by the preceding token, whole words included, or by a `)` that closes a
 * statement head (`if (…) /re/`); an unusual expression shape can still put a
 * real literal on the wrong side of that heuristic — a regex whose first token
 * follows a `}` that closed a block is read as a division, and a division in
 * that one position as a regex. The runtime containment tests are the other
 * half of the evidence.
 *
 * Scope: production sources only. `packages/<pkg>/src` and
 * `packages/<pkg>/scripts` for every workspace, plus the whole trees of
 * `packages/contrib`, `packages/providers` and `packages/skills` (their
 * layouts are not src-shaped). Test trees are excluded by name: a test that
 * writes into a temporary cwd is exercising the hazard this gate reports,
 * inside its own fixture.
 *
 * Allowlist: one entry per sanctioned site, keyed by file, the resolved
 * write-family callee and the canonical form of the expanded first argument
 * (whitespace runs collapsed). The argument is matched whole, never as a
 * substring, so a second write in an allowlisted file is a finding even when
 * its target names the same artifact. It holds three entries in two files,
 * all `source-dir` shapes — the generated schema artifact (directory creation
 * and write) and the workers registry's parent directory. A new write
 * anywhere else in those files matches no entry and is a finding.
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
 * Allowlisted sites: file + resolved callee + the canonical form of the
 * expanded first argument + reason, one entry per sanctioned call. The
 * argument is matched WHOLE, never as a substring, so a new write in an
 * allowlisted file matches no entry and is a finding even when its target
 * names the same artifact. Whitespace runs are collapsed first, so reindenting
 * a sanctioned call does not change its key.
 */
const ALLOWLIST = [
  {
    file: "packages/core/scripts/gen-braid-schema.mjs",
    callee: "mkdirSync",
    firstArg:
      'dirname(join(resolve(__dirname, "..", "..", ".."), "packages/core/schema/braid.schema.json"))',
    reason:
      "creates the directory of the generated braid schema artifact, which check-braid-schema.mjs owns and pins",
  },
  {
    file: "packages/core/scripts/gen-braid-schema.mjs",
    callee: "writeFileSync",
    firstArg:
      'join(resolve(__dirname, "..", "..", ".."), "packages/core/schema/braid.schema.json")',
    reason:
      "writes the generated braid schema artifact, which check-braid-schema.mjs owns and pins",
  },
  {
    file: "packages/core/src/lib/orchestrator/workers.ts",
    callee: "mkdirSync",
    firstArg: "dirname(getWorkersFilePath(cwd ?? process.cwd()))",
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

/**
 * Statement heads: the `)` closing one of these leaves a statement position,
 * where a `/` starts a regex (`while (n) /re/.test(s)`), not a division. The
 * tokens are read whole, so `iffy(…)` is not `if (…)`.
 */
const STATEMENT_HEADS = new Set(["if", "while", "for", "switch", "catch", "with"]);

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

/**
 * Walk a code region, literal-aware: comments and the interiors of string,
 * template and regex literals are stepped over, so a `}` inside one can never
 * close a template interpolation. `blank(from, to, false)` reports every
 * non-code region; the walk itself only reads.
 *
 * `prev` holds the last significant token, read as a whole word, so the regex
 * heuristic sees `return` rather than its last letter, and a `/` after the `)`
 * closing a statement head is a regex rather than a division.
 *
 * With `stopAtClose` the walk returns at the `}` that closes the enclosing
 * template interpolation, tracking brace depth so an object literal inside
 * (`${{ a: 1 }}`) does not end it early.
 *
 * Returns `{ i, prev }`, where `i` is the index the walk stopped at.
 */
function scanCode(text, from, to, { prev = "", stopAtClose = false, blank = () => {} } = {}) {
  let i = from;
  let depth = 0;
  // The `)` just consumed closed a statement head, so a `/` after it starts a
  // regex. Cleared by the next significant token.
  let afterHeadParen = false;
  /** One flag per open paren: was it opened right after a statement head? */
  const parens = [];
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
      afterHeadParen = false;
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(text, i, to, blank);
      prev = "`";
      afterHeadParen = false;
      continue;
    }
    if (ch === "/" && (afterHeadParen || REGEX_AFTER.has(prev))) {
      const end = skipRegexLiteral(text, i);
      blank(i, end, false);
      i = end;
      prev = "/";
      afterHeadParen = false;
      continue;
    }
    if (ch === "(") {
      parens.push(STATEMENT_HEADS.has(prev));
      prev = "(";
      afterHeadParen = false;
      i++;
      continue;
    }
    if (ch === ")") {
      afterHeadParen = parens.pop() ?? false;
      prev = ")";
      i++;
      continue;
    }
    if (stopAtClose) {
      if (ch === "{") {
        depth++;
        prev = "{";
        afterHeadParen = false;
        i++;
        continue;
      }
      if (ch === "}") {
        if (depth === 0) return { i, prev };
        depth--;
        prev = "}";
        afterHeadParen = false;
        i++;
        continue;
      }
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const word = readWord(text, i, to);
      // A word after `.` is a property name, and a property access ends a
      // value: `o.in / 2` and `cache.delete / 2` are divisions even though
      // `in` and `delete` are operators in their own right.
      prev = prev === "." ? ")" : word;
      i += word.length;
    } else {
      prev = ch;
      i++;
    }
    afterHeadParen = false;
  }
  return { i: to, prev };
}

/**
 * Blank a template literal's body and scan its `${…}` expressions; returns the
 * index just past the closing backtick. An interpolation opens in expression
 * position, so its scan starts from `(`: a `/` directly inside `${}` is a
 * regex, and a `}` inside that regex, a comment or a string cannot close the
 * interpolation early. The backticks and the `${` / `}` delimiters stay in
 * place (a quoted bracket key must still read as a quoted key); only the body
 * blanks.
 */
function skipTemplate(text, start, to, blank) {
  let i = start + 1;
  while (i < to) {
    if (text[i] === "\\") {
      blank(i, i + 2, false);
      i += 2;
      continue;
    }
    if (text[i] === "`") return i + 1;
    if (text[i] === "$" && text[i + 1] === "{") {
      blank(i, i + 2, false);
      const inner = scanCode(text, i + 2, to, { prev: "(", stopAtClose: true, blank });
      blank(inner.i, inner.i + 1, false);
      i = inner.i + 1;
      continue;
    }
    blank(i, i + 1, false);
    i += 1;
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
  scanCode(text, 0, text.length, { blank });
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
  // TypeScript's import-equals form binds the module like a namespace import.
  each(/\bimport\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g, (m) => {
    if (FS_MODULES.has(m[2])) namespaces.add(m[1]);
  });
  each(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g, (m) => {
    if (FS_MODULES.has(m[2])) namespaces.add(m[1]);
  });
  each(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g, (m) => {
    if (!FS_MODULES.has(m[2])) return;
    for (const [imported, local] of specifiers(m[1], /\s*:\s*/)) {
      if (imported === "promises") namespaces.add(local ?? imported);
      else if (WRITE_CALLS.includes(imported)) writes.set(local ?? imported, imported);
    }
  });

  // Dynamic import, namespace and destructured forms:
  // `const fsp = await import("node:fs/promises")`,
  // `const { writeFile: wf } = await import("node:fs")`.
  const DYNAMIC_IMPORT = `await\\s+import\\s*\\(\\s*["']([^"']+)["']\\s*\\)`;
  each(
    new RegExp(`\\b(?:const|let|var)\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${DYNAMIC_IMPORT}`, "g"),
    (m) => {
      if (FS_MODULES.has(m[2])) namespaces.add(m[1]);
    },
  );
  each(
    new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${DYNAMIC_IMPORT}`, "g"),
    (m) => {
      if (FS_MODULES.has(m[2])) namespaces.add(m[1]);
    },
  );
  each(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${DYNAMIC_IMPORT}`, "g"), (m) => {
    if (!FS_MODULES.has(m[2])) return;
    for (const [imported, local] of specifiers(m[1], /\s*:\s*/)) {
      if (imported === "promises") namespaces.add(local ?? "promises");
      else if (WRITE_CALLS.includes(imported)) writes.set(local ?? imported, imported);
    }
  });

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const add = (set, value) => {
      if (!set.has(value)) {
        set.add(value);
        changed = true;
      }
    };
    /** Bind `local` to whatever the member chain `chainText` resolves to. */
    const bind = (local, chainText) => {
      const chain = chainText.split(/\s*\.\s*/);
      const [obj, prop] = chain;
      if (chain.length === 1) {
        const target = writes.get(obj);
        if (target && !writes.has(local)) {
          writes.set(local, target);
          changed = true;
        }
        if (namespaces.has(obj)) add(namespaces, local);
        return;
      }
      if (chain.length === 2) {
        if (namespaces.has(obj) && prop === "promises") add(namespaces, local);
        if (namespaces.has(obj) && WRITE_CALLS.includes(prop) && !writes.has(local)) {
          writes.set(local, prop);
          changed = true;
        }
        return;
      }
      if (chain.length === 3 && chain[1] === "promises") {
        if (namespaces.has(obj) && WRITE_CALLS.includes(chain[2]) && !writes.has(local)) {
          writes.set(local, chain[2]);
          changed = true;
        }
      }
    };

    // A local name bound to an fs member chain, declared or assigned:
    // `const wf = fs.writeFileSync`, `let wf; wf = fs.writeFileSync`,
    // `const wf = fs.writeFileSync.bind(fs)` and the second declarator of
    // `const wf = fs.writeFileSync, md = fs.mkdirSync` all bind the name.
    each(
      /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\.\s*bind\s*\([^)]*\))?\s*(?=[;,\n]|$)/g,
      (m) => bind(m[1], m[2]),
    );
    // The same capture with a type annotation between name and `=`.
    each(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;,\n]*?)?=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\.\s*bind\s*\([^)]*\))?\s*(?=[;,\n]|$)/g,
      (m) => bind(m[1], m[2]),
    );
    // Destructuring from a namespace or from its `promises` member:
    // `const { writeFileSync } = fs`, `const { writeFileSync } = fs.promises`.
    each(
      /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?=[;,\n]|$)/g,
      (m) => {
        if (!isFsNamespace(m[2], namespaces)) return;
        for (const [prop, local] of specifiers(m[1], /\s*:\s*/)) {
          if (prop === "promises") add(namespaces, local ?? prop);
          else if (WRITE_CALLS.includes(prop) && !writes.has(local ?? prop)) {
            writes.set(local ?? prop, prop);
            changed = true;
          }
        }
      },
    );
    if (!changed) break;
  }
  return { namespaces, writes };
}

/** True when `object` names an fs namespace (or `<ns>.promises`). */
function isFsNamespace(object, namespaces) {
  const o = object.trim();
  if (namespaces.has(o)) return true;
  const m = /^(.*)\.\s*promises$/.exec(o);
  return m !== null && namespaces.has(m[1].trim());
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
    return isFsNamespace(object, table.namespaces) && WRITE_CALLS.includes(prop) ? prop : null;
  }
  const member = /^(.*)\.\s*([A-Za-z_$][\w$]*)$/.exec(chainText);
  if (member) {
    const object = member[1].trim();
    const prop = member[2];
    return isFsNamespace(object, table.namespaces) && WRITE_CALLS.includes(prop) ? prop : null;
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
 * The static base of a template-literal target: its leading static text plus
 * every interpolation that is itself a quoted string literal, concatenated —
 * `` `${'.'}/p11.json` `` bases at `./p11.json`. Reading stops at the first
 * interpolation that is not a literal, so a genuinely dynamic base
 * (`` `${os.tmpdir()}/x` ``) yields an empty base and stays out of reach
 * (see the bounds in the header). Returns null when `expr` is no template.
 */
function templateBase(expr) {
  const s = expr.trim();
  if (s[0] !== "`") return null;
  let i = 1;
  let out = "";
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      out += s[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "`") break;
    if (ch === "$" && s[i + 1] === "{") {
      const close = scanCode(s, i + 2, s.length, { stopAtClose: true }).i;
      const literal = unquote(s.slice(i + 2, close));
      if (literal === null) break; // dynamic from here on
      out += literal;
      i = close + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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
  // A template whose leading interpolation is a relative literal bases the
  // target at that literal: `${'.'}/p11.json` writes beside the cwd.
  const tplBase = templateBase(targetBase(expanded));
  if (tplBase !== null && tplBase !== "" && !isAbsolute(tplBase)) {
    return { id: "relative-literal", token: JSON.stringify(tplBase) };
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

// ── Local module re-exports ─────────────────────────────────────────────────

/** Rel paths of the scanned production files (set in main). */
let scannedFiles = new Set();

/** `A as B` / `A` specifier lists, as [imported, local] pairs. */
function specifierPairs(list, separator) {
  const out = [];
  for (const spec of list.split(",")) {
    const parts = spec
      .trim()
      .split(separator)
      .map((s) => s.trim());
    if (parts[0]) out.push(parts);
  }
  return out;
}

/** TypeScript twins of the JS-family extensions a compiled specifier may
 *  carry. The repo imports its own sources with the emitted spelling
 *  (`from "../config/braid-paths.js"`), so `./x.js` must also name `./x.ts`. */
const TS_TWINS = {
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
  ".jsx": [".tsx"],
};

/** The scanned file a relative specifier names, or null. The exact specifier
 *  is tried first, then the TypeScript twin of its extension, then the
 *  extensionless candidates beside the importer, or its index. */
function resolveLocalSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(root, dirname(fromFile), spec);
  const candidates = [base];
  const ext = Object.keys(TS_TWINS).find((e) => spec.endsWith(e));
  if (ext) {
    const stripped = base.slice(0, -ext.length);
    for (const twin of TS_TWINS[ext]) candidates.push(`${stripped}${twin}`);
  }
  candidates.push(
    `${base}.ts`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.mjs`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.mjs"),
    join(base, "index.js"),
  );
  for (const candidate of candidates) {
    const rel = relative(root, candidate);
    if (scannedFiles.has(rel)) return rel;
  }
  return null;
}

/** Named imports from a relative specifier, as { imported, local, spec }. */
function localImports(text, isCode) {
  const out = [];
  const re = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    if (!isCode[m.index]) continue;
    for (const [imported, local] of specifierPairs(m[1], /\s+as\s+/)) {
      out.push({ imported, local, spec: m[2] });
    }
  }
  return out;
}

const reexportCache = new Map();

/**
 * Write-family names a scanned local module exports, keyed by the name an
 * importer sees: `export { writeFileSync as wf }` and
 * `export const wf = fs.writeFileSync` both map `wf` to `writeFileSync`, and
 * `export { wf } from "./other.mjs"` follows one more hop. `seen` bounds the
 * walk so a cycle terminates; results are cached per file, so a cyclic module
 * contributes what its walk reached.
 */
function localWriteExports(relFile, seen = new Set()) {
  if (seen.has(relFile)) return new Map();
  const cached = reexportCache.get(relFile);
  if (cached && seen.size === 0) return cached;
  seen.add(relFile);
  const text = readFileSync(join(root, relFile), "utf8");
  const { isCode } = maskNonCode(text);
  const table = fsBindings(text, isCode);
  const out = new Map();
  const each = (re, fn) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (isCode[m.index]) fn(m);
    }
  };
  each(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m) => {
    const canonical = table.writes.get(m[1]);
    if (canonical) out.set(m[1], canonical);
  });
  each(/\bexport\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g, (m) => {
    let source = null;
    if (m[2] !== undefined) {
      const target = resolveLocalSpecifier(relFile, m[2]);
      if (target === null) return;
      source = localWriteExports(target, seen);
    }
    for (const [local, name] of specifierPairs(m[1], /\s+as\s+/)) {
      const canonical = source !== null ? source.get(local) : table.writes.get(local);
      if (canonical) out.set(name ?? local, canonical);
    }
  });
  if (seen.size === 1) reexportCache.set(relFile, out);
  return out;
}

/** The canonical form of a target expression: whitespace runs collapsed, so a
 *  reindented call keeps the same key. */
function canonicalExpr(expr) {
  return expr.replace(/\s+/g, " ").trim();
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
scannedFiles = new Set(files);

for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  const { masked, isCode } = maskNonCode(text);
  const bindings = fileBindings(text);
  const table = fsBindings(text, isCode);
  // A write-family name re-exported from a scanned local module resolves too.
  for (const { imported, local, spec } of localImports(text, isCode)) {
    const target = resolveLocalSpecifier(file, spec);
    if (target === null) continue;
    const canonical = localWriteExports(target).get(imported);
    if (canonical) table.writes.set(local ?? imported, canonical);
  }
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
      (a) => a.file === file && a.callee === name && a.firstArg === canonicalExpr(expanded),
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
