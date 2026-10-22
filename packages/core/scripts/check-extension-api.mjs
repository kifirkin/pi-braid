#!/usr/bin/env node
/**
 * check-extension-api.mjs — catch extension code calling extension-host
 * APIs that do not exist.
 *
 * Failure mode (observed): a handler received its context parameter typed
 * `any` and called `ctx.getExtensionState(...)` — an API pi-core does not
 * expose (the real braid helper is the free function `readExtensionState`).
 * TypeScript could not flag it, the call returned undefined at runtime, and
 * every read it fed silently rendered nothing until someone traced it by
 * hand. `npm run typecheck` only sees `ctx.<member>` on a REAL ExtensionContext;
 * the class this script guards is the any-typed (or untyped) context variable.
 *
 * Method: scan every tracked .ts file under packages/core/src for
 * `ctx.<member>(...)` calls and `ctx?.<member>(...)`, then allow the member
 * by exactly one of:
 *
 *   1. pi-core surface — hardcoded member set extracted from the type
 *      declarations of one pi-core version, pinned at PI_CORE_BASELINE
 *      below. The ALLOW set is frozen: a green run vouches for that
 *      baseline, not for whatever version happens to be installed. The
 *      staleness line at the end compares it against the declarations
 *      actually installed, in both directions, and names every difference —
 *      so the note is evidence about the installed surface, not a guess from
 *      a version string. Regenerate with:
 *        awk '/^export interface ExtensionAPI[ {]/,/^\}/' + ExtensionContext
 *        + ExtensionCommandContext over <install>/node_modules/
 *        @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts,
 *        then keep the unique member names
 *   2. declared context field — the member name is a field of some
 *      interface/type-alias declared in the project (any tracked .ts file).
 *      Braid passes locally-typed context shapes (PruneContext,
 *      PolicyContext, EvaluationContext, ...) into helpers whose parameters
 *      are also named `ctx`; those members are real by construction.
 *
 * Everything else is reported: file, line, member, source text. Modes:
 *   node packages/core/scripts/check-extension-api.mjs            report-only, exit 0
 *   node packages/core/scripts/check-extension-api.mjs --strict   exit 1 on any hit
 *
 * Limits (documented, on purpose): this is a tripwire, not a type checker.
 * A typo whose name collides with any declared interface field slips
 * through; comment and string-literal mentions are ignored (the class is
 * live calls); only variables named `ctx` are scanned.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const strict = process.argv.includes("--strict");

/**
 * Frozen baseline: pi-core 1.4.0, extracted from that version's
 * @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts.
 *
 * It is deliberately not re-derived per run, so a green run says nothing about
 * the surface of the pi-core actually installed — the staleness note below
 * reports that comparison explicitly. The 1.4.0 declarations and the 1.2.0
 * ones this repo's dev baseline pins are member-for-member equal (58 members
 * each), so one set covers both. To refresh: re-extract from the installed
 * declarations and bump PI_CORE_BASELINE in the same commit.
 */
const PI_CORE_BASELINE = "1.4.0";
const PI_CORE_SURFACE = new Set([
  // ExtensionAPI (the `pi` object; kept here because some helpers accept it
  // through a `ctx`-shaped indirection and one shared set is easier to audit)
  "on", "registerTool", "registerCommand", "registerShortcut", "registerFlag",
  "getFlag", "registerMessageRenderer", "registerMarkdownTransformer",
  "registerEntryRenderer", "registerToolRenderer", "sendMessage", "sendUserMessage",
  "appendEntry", "setSessionName", "getSessionName", "setLabel", "exec",
  "getActiveTools", "getAllTools", "getSettings", "setActiveTools", "getCommands",
  "setModel", "getThinkingLevel", "setThinkingLevel", "registerProvider",
  "unregisterProvider", "registerMcpServer", "unregisterMcpServer", "getMcpServers",
  "registerVirtualModel", "unregisterVirtualModel", "events",
  // ExtensionContext
  "ui", "mode", "hasUI", "cwd", "sessionManager", "modelRegistry", "model",
  "scopedModels", "thinkingLevel", "isIdle", "isProjectTrusted", "signal",
  "abort", "hasPendingMessages", "shutdown", "getContextUsage", "compact",
  "getSystemPrompt",
  // ExtensionCommandContext (command handlers)
  "getSystemPromptOptions", "waitForIdle", "newSession", "fork",
  "navigateTree", "switchSession", "reload",
]);

// Access on a variable named `ctx` (optional-chained or not): both method
// calls and property reads. The observed failure mode was a call, but a
// bare property (e.g. passing `ctx.getExtensionState` as a callback) dies
// the same silent way.
const ACCESS_RE = /(?<![\w$.])ctx\??\.([A-Za-z_$][\w$]*)/g;

/** Recursive walk of the working tree — not `git ls-files`. A guard must
 *  see the file a developer just wrote, which is untracked at exactly the
 *  moment the guard matters most. */
function walkTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = resolve(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, out);
    else if (/\.(?:[cm]?ts)$/.test(entry)) out.push(p);
  }
  return out;
}

/** Collect every field name declared in any interface or type-alias in `text`. */
function declaredFields(text) {
  const fields = new Set();
  const lines = text.split("\n");
  let depth = 0;
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock && /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+/.test(line)) {
      inBlock = true;
      depth = 0;
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      if (opens > closes) {
        depth = opens - closes;
      } else if (opens === closes && opens > 0) {
        inBlock = false; // one-line type
        continue;
      } else {
        continue; // header without a block body (e.g. `type X = Foo`)
      }
      continue;
    }
    if (inBlock) {
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      depth += opens - closes;
      if (depth <= 0) {
        inBlock = false;
      } else {
        // Field declarations: `name:`, `name?:`, `readonly name?:`, method `name(`.
        const m = line.match(/^\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?]?[:<]/);
        if (m) fields.add(m[1]);
      }
    }
  }
  return fields;
}

/** Strip line comments and block comments, preserving line structure. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"])\/\/[^\n]*/g, "$1");
}

/** The installed pi-core package — version and the declarations file that
 *  describes its surface — or null when it is not resolvable. */
function installedPiCore() {
  const root = resolve(
    __dirname, "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent",
  );
  try {
    const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version ?? null;
    if (!version) return null;
    return { version, declarations: resolve(root, "dist/core/extensions/types.d.ts") };
  } catch {
    return null;
  }
}

/**
 * The member set of ExtensionAPI + ExtensionContext + ExtensionCommandContext
 * in a declarations file, or null when it cannot be read or does not parse into
 * a plausible surface.
 *
 * Only the staleness note uses this. The ALLOW set stays frozen, so a green run
 * still vouches for the baseline; this extraction exists so the note can say
 * what is actually different instead of inferring trouble from a version
 * string.
 */
function extractPiCoreSurface(declarations) {
  let text;
  try {
    text = stripComments(readFileSync(declarations, "utf8"));
  } catch {
    return null;
  }
  const members = new Set();
  for (const name of ["ExtensionAPI", "ExtensionContext", "ExtensionCommandContext"]) {
    const header = new RegExp(`^export interface ${name}\\b`, "m").exec(text);
    if (!header) return null;
    const open = text.indexOf("{", header.index);
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) return null;
    // Member names at nesting depth 0. A name inside an inline object type is
    // not part of the interface surface, and a brace inside a string literal
    // (or a skipped quote) must not shift the depth.
    let nested = 0;
    for (const line of text.slice(open + 1, close).split("\n")) {
      if (nested === 0) {
        const m = line.match(/^\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?(<:]/);
        if (m) members.add(m[1]);
      }
      let quote = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === quote && line[i - 1] !== "\\") quote = "";
        } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "{" || ch === "(") nested++;
        else if (ch === "}" || ch === ")") nested = Math.max(0, nested - 1);
      }
    }
  }
  // A reshaped or renamed interface parses into almost nothing; that is a
  // parse failure to report, not a surface to compare against.
  return members.size >= 40 ? members : null;
}

/**
 * Staleness suffix for the clean line: empty only when the frozen set matches
 * the installed declarations member-for-member.
 *
 * It compares surfaces rather than version strings on purpose. A set extracted
 * from one release is still exact for a differently versioned install whose
 * declarations carry the same members, and a version comparison would call that
 * a failure it cannot see the inside of. The two directions are reported
 * separately: an installed member the set lacks is a legitimate call the guard
 * would refuse; a set member the install lacks is an allow for a call that no
 * longer exists.
 */
function baselineNote() {
  const installed = installedPiCore();
  if (!installed) {
    return "\n   ⚠️  frozen baseline: no installed pi-core package found; re-extract the member set from its declarations";
  }
  const surface = extractPiCoreSurface(installed.declarations);
  if (!surface) {
    return `\n   ⚠️  frozen baseline: could not read a member set from installed pi-core ${installed.version} (${installed.declarations}); re-extract it by hand`;
  }
  const missing = [...surface].filter((m) => !PI_CORE_SURFACE.has(m)).sort();
  const stale = [...PI_CORE_SURFACE].filter((m) => !surface.has(m)).sort();
  if (missing.length === 0 && stale.length === 0) return "";
  const parts = [];
  if (missing.length) {
    parts.push(`${missing.length} installed member(s) missing from the frozen set: ${missing.join(", ")}`);
  }
  if (stale.length) {
    parts.push(
      `${stale.length} frozen member(s) absent from installed ${installed.version}: ${stale.join(", ")}`,
    );
  }
  return `\n   ⚠️  frozen baseline ${PI_CORE_BASELINE} vs installed pi-core ${installed.version}: ${parts.join("; ")}`;
}

const srcDir = resolve(__dirname, "..", "src");
const files = walkTsFiles(srcDir).filter(
  (p) => !p.includes("/dist/") && !p.includes("/node_modules/"),
);
const declared = new Set();
const fileTexts = new Map();
for (const f of files) {
  const raw = readFileSync(f, "utf8");
  // Field extraction runs on comment-stripped text: a doc comment that
  // quotes a type cast (`ctx as { getExtensionState?: unknown }`) opens a
  // brace that corrupts block tracking and declares the dead API as a
  // real field — exactly the false-allow that blinded the first run.
  const text = stripComments(raw);
  fileTexts.set(f, text);
  for (const name of declaredFields(text)) declared.add(name);
}

const hits = [];
let callsChecked = 0;
for (const [f, text] of fileTexts) {
  const lines = stripComments(text).split("\n");
  lines.forEach((line, i) => {
    ACCESS_RE.lastIndex = 0;
    let m;
    while ((m = ACCESS_RE.exec(line)) !== null) {
      callsChecked++;
      const member = m[1];
      if (PI_CORE_SURFACE.has(member)) continue;
      if (declared.has(member)) continue;
      hits.push({ file: f.slice(srcDir.length + 1), line: i + 1, member, text: line.trim() });
    }
  });
}

if (hits.length === 0) {
  console.log(
    `✅ check-extension-api: ${files.length} files, ${callsChecked} ctx accesses, ` +
      `0 unclassified (pi-core ${PI_CORE_BASELINE} baseline surface + ${declared.size} declared project fields)${baselineNote()}`,
  );
  process.exit(0);
}

console.log(`❌ check-extension-api: ${hits.length} unclassified ctx access(es):`);
for (const h of hits) {
  console.log(`  ${h.file}:${h.line}  ctx.${h.member}  —  ${h.text}`);
}
console.log(
  "\nAllow the member by fixing the call (the API does not exist) or by\n" +
    "declaring the context type it belongs to. Free-function helpers\n" +
    "(readExtensionState, getExtensionState(ctx, key, factory)) are the\n" +
    "supported way to reach extension state — see lib/state/extension-state.ts.",
);
if (strict) process.exit(1);
