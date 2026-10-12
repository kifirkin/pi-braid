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
 *   1. pi-core surface — hardcoded member set extracted from the installed
 *      pi-core type declarations of one version, pinned at PI_CORE_BASELINE
 *      below. The set is frozen: a green run vouches for that baseline, not
 *      for the pi-core version actually installed. Regenerate with:
 *        awk '/export interface ExtensionContext \{/,/^\}/' + ExtensionAPI +
 *        ExtensionCommandContext over ~/.pi/agent/local-packages/node_modules/
 *        @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
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
 * Frozen baseline: pi-core 0.85.1, extracted from that version's
 * @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts.
 *
 * It is deliberately not re-derived per run, so a green run says nothing about
 * the surface of the pi-core actually installed — the summary line names both
 * versions when they differ. To refresh: re-extract from the installed
 * declarations and bump PI_CORE_BASELINE in the same commit.
 */
const PI_CORE_BASELINE = "0.85.1";
const PI_CORE_SURFACE = new Set([
  // ExtensionAPI (the `pi` object; kept here because some helpers accept it
  // through a `ctx`-shaped indirection and one shared set is easier to audit)
  "on", "registerTool", "registerCommand", "registerShortcut", "registerFlag",
  "getFlag", "registerMessageRenderer", "registerMarkdownTransformer",
  "registerEntryRenderer", "sendMessage", "sendUserMessage", "appendEntry",
  "setSessionName", "getSessionName", "setLabel", "exec", "getActiveTools",
  "getAllTools", "setActiveTools", "getCommands", "setModel", "getThinkingLevel",
  "setThinkingLevel", "registerProvider", "unregisterProvider", "events",
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

/** The pi-core version actually installed here, or null when it is not resolvable. */
function installedPiCoreVersion() {
  const manifest = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** Staleness suffix for the clean line: empty only when the baseline IS the installed version. */
function baselineNote() {
  const installed = installedPiCoreVersion();
  if (!installed || installed === PI_CORE_BASELINE) return "";
  return `\n   ⚠️  frozen baseline: installed pi-core is ${installed}; re-extract the member set from its declarations`;
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
