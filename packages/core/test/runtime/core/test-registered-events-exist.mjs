/**
 * Structural guard: every event name registered through pi.on()/onEvent()
 * in the built dist must be an event pi-core actually fires — a member of
 * the on() overload name set in @earendil-works/pi-coding-agent's
 * ExtensionAPI declaration (dist/core/extensions/types.d.ts).
 *
 * Why: braid carried seven handlers registered on names pi-core never emits
 * (compaction_end, session_end, auto_retry_end, user_message, context_cleanup)
 * — each handler was dead code whose logic silently never ran. A handler on a
 * non-event name typechecks (pi.on is widened through the permissive helper),
 * so only a structural check catches the drift. If a registration site moves
 * to a name outside the accepted set, this test fails with the file, line,
 * and name.
 *
 * How it works:
 *   1. Read the accepted name set from pi-core's types.d.ts by collecting the
 *      string literals of the on(event: "...") overloads. No hardcoded list:
 *      a pi-core upgrade that adds or renames events is picked up directly.
 *   2. Scan every built dist file (run-tests builds
 *      first), strip comments and string bodies, then extract the first
 *      argument of every pi.on( call and the second argument of every
 *      onEvent( call — including the widened-cast call shape
 *      `(pi.on as (...) => void)(name, ...)` used by a few registration sites.
 *   3. A string literal must be a member; an identifier must resolve through
 *      dist/lib/core/event-names.js to a member; anything else is a violation
 *      so the registration site gets named, not skipped.
 *
 * Run: node test/runtime/core/test-registered-events-exist.mjs
 *      (after npm run build — the test reads dist, not src)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, "..", "..", "..");

// ── Resolve pi-core's package directory ──────────────────────────────────────
// Subpath imports of the package's own files are not exported
// (ERR_PACKAGE_PATH_NOT_EXPORTED), and the exports map defines only ESM
// conditions for "." - resolve with import.meta.resolve and walk up to the
// package root, then read the .d.ts that ships inside the package.
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const PKG_DIST = dirname(fileURLToPath(entryUrl)); // .../dist
const TYPES_DTS = join(PKG_DIST, "core", "extensions", "types.d.ts");

let dts;
try {
  dts = readFileSync(TYPES_DTS, "utf-8");
} catch (e) {
  console.error(
    `FAIL: cannot read pi-core's extension type declarations at ${TYPES_DTS} (${e.message}).\n` +
      `The accepted-name extraction needs this file; if the package moved it, update TYPES_DTS.`,
  );
  process.exit(1);
}

// ── 1. Accepted name set from the on() overloads ─────────────────────────────
const accepted = new Set();
for (const m of dts.matchAll(/\bon\(event:\s*"([a-z_]+)"/g)) {
  accepted.add(m[1]);
}
if (accepted.size < 30) {
  console.error(
    `FAIL: extracted only ${accepted.size} accepted event names from pi-core's on() ` +
      `overloads — the extraction regex no longer matches the declaration. ` +
      `Names seen: ${[...accepted].sort().join(", ")}`,
  );
  process.exit(1);
}

// ── 2. Scan dist for registered names ────────────────────────────────────────

/**
 * Strip comments; keep string-literal content but defuse the parens and
 * commas inside strings so the balanced-paren walk only sees code structure.
 */
function neutralize(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          // keep escaped chars verbatim so quote detection stays correct
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (src[i] === "\n") out += "\n";
        // defuse structure characters inside the literal
        if (src[i] === "(" || src[i] === ")" || src[i] === ",") out += " ";
        else out += src[i];
        i++;
      }
      out += c; // closing quote
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Extract the balanced top-level argument list starting at `open` (index of "("). */
function extractArgs(neutral, open) {
  let depth = 0;
  for (let i = open; i < neutral.length; i++) {
    if (neutral[i] === "(") depth++;
    else if (neutral[i] === ")") {
      depth--;
      if (depth === 0) return neutral.slice(open + 1, i);
    }
  }
  return null;
}

/** Split a top-level argument list on commas. */
function splitArgs(argsSrc) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const c of argsSrc) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Normalise the widened-cast call shape `(pi.on as ...)(name, ...)` so the
// plain pi.on( matcher sees it. The non-greedy cast body ends at the first
// `)(` after `as`, which is the cast's closing paren followed by the call.
const CAST_CALL = /\(pi\.on\s+as[\s\S]*?\)\s*\(/g;

function collectRegistrations(js) {
  const neutral = neutralize(js);
  const normalised = neutral.replace(CAST_CALL, "pi.on(");
  const found = [];
  for (const m of normalised.matchAll(/\bpi\.on\s*\(/g)) {
    const open = normalised.indexOf("(", m.index);
    const args = splitArgs(extractArgs(normalised, open) ?? "");
    if (args.length) found.push({ arg: args[0], via: "pi.on" });
  }
  for (const m of normalised.matchAll(/\bonEvent\s*\(/g)) {
    const open = normalised.indexOf("(", m.index);
    const args = splitArgs(extractArgs(normalised, open) ?? "");
    if (args.length > 1) found.push({ arg: args[1], via: "onEvent" });
  }
  return found;
}

function walk(dir, base) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = join(base, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      files.push(...walk(full, rel));
    } else if (entry.endsWith(".js") && !entry.endsWith(".d.ts")) {
      files.push(rel);
    }
  }
  return files;
}

const DIST = join(CORE_ROOT, "dist");
let distFiles;
try {
  distFiles = walk(DIST, "");
} catch (e) {
  console.error(
    `FAIL: cannot read the build output at ${DIST} (${e.message}). Run npm run build first.`,
  );
  process.exit(1);
}

// ── 3. Resolve names and check membership ────────────────────────────────────

// Reverse map constant-value -> exported name, from the built event-names
// module. Also verifies the constants themselves still point at real events:
// a constant renamed to a dead name resolves to a non-member and fails here.
const ALLOWED_FILES = new Set(["lib/events/event-types.js"]);
const namesMod = await import(join(DIST, "lib", "core", "event-names.js"));
const constReverse = new Map();
for (const [key, value] of Object.entries(namesMod)) {
  if (typeof value === "string") constReverse.set(value, key);
}

const violations = [];
let checked = 0;

for (const rel of distFiles) {
  if (ALLOWED_FILES.has(rel)) continue; // onEvent's own definition
  const js = readFileSync(join(DIST, rel), "utf-8");
  for (const { arg, via } of collectRegistrations(js)) {
    const trimmed = arg.trim();
    let name = null;
    let origin = trimmed;
    const literal = trimmed.match(/^["']([a-z_]+)["']$/);
    if (literal) {
      name = literal[1];
    } else if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      const value = namesMod[trimmed];
      if (typeof value === "string") {
        name = value;
        origin = `${trimmed} ("${value}")`;
      }
    }
    checked++;
    if (!name) {
      violations.push({ file: rel, via, arg: trimmed, reason: "unresolvable first argument" });
    } else if (!accepted.has(name)) {
      violations.push({
        file: rel,
        via,
        arg: origin,
        reason: `not an event pi-core fires (accepted: ${accepted.size} names)`,
      });
    }
  }
}

if (violations.length > 0) {
  console.log(
    `\u274c ${violations.length} event registration(s) on names pi-core never fires:\n`,
  );
  for (const v of violations) {
    console.log(`  ${v.file}  ${v.via}(${v.arg})  — ${v.reason}`);
  }
  console.log(
    `\nEvery pi.on()/onEvent() name must be a member of the accepted set\n` +
      `extracted from pi-core's ExtensionAPI.on() overloads (${accepted.size} names).\n` +
      `Registering on a non-event name is silent dead code: the handler never runs.\n`,
  );
  process.exit(1);
}

console.log(
  `\u2705 all ${checked} registered event name(s) are pi-core extension events ` +
    `(${accepted.size} accepted)`,
);
