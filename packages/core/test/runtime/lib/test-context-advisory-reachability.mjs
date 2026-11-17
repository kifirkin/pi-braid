/**
 * Every context tool an advisory names must be one the agent can call.
 *
 * WHY THIS EXISTS:
 *   braid registers its cold tools with `exposure: "deferred"`: the declaration
 *   leaves every provider request, and the only thing that can activate one is
 *   `tool_search`. An advisory that says "inspect with context_inspect" therefore
 *   asks for a call the agent cannot make without first searching - and in the
 *   measured 15-hour seat the agent made it zero times. An instruction whose
 *   named instrument is unreachable produces no verification, and the agent
 *   reads the absence as "there was nothing to check".
 *
 * WHAT THIS PINS, over the advisory surface this change owns (the lifecycle
 * modules, the rotation handler, and the compress tool's advisory strings):
 *   - no prose string names a deferred context tool without also naming
 *     `tool_search` in the same string (the path that activates it);
 *   - no structured `tool: "<name>"` advice field names a deferred context tool;
 *   - a tool that is on the default surface (registered, not deferred) may be
 *     named bare, and is.
 *
 * The registry side is derived, never restated: registered `context_*` tool
 * names come from the `name:` field of their declarations, and the deferred set
 * from the `exposure: "deferred"` that follows it. The rule is self-tested
 * against synthetic prose first (a bare cold name must report, the same name
 * with `tool_search` must not, a live name must not), so a detector that
 * silently stops matching fails here instead of passing quietly.
 *
 * SCOPE, stated so it can be argued with: the files below are the surface this
 * change owns. The same defect exists today in files outside it -
 * `extensions/core/prompt-builder/awareness-whisper.ts` ("Inspect with
 * context_inspect"), `extensions/enforcement/handlers/register-post-cycle-hygiene.ts`
 * (`context_inspect(detail="prune")`),
 * `extensions/enforcement/handlers/register-session-start-discoverability.ts`,
 * and `extensions/memory/context-manager/handlers/tools/context-navigate.ts`
 * (`nextStep: { tool: "context_inspect" }`). They are listed, not silently
 * excluded: widening the surface means adding them here.
 *
 * Run: node test/runtime/lib/test-context-advisory-reachability.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src");

/** The advisory surface this change owns. */
const SURFACE = [
  "extensions/memory/context-lifecycle/index.ts",
  "extensions/memory/context-lifecycle/state.ts",
  "extensions/memory/context-lifecycle/policy-engine.ts",
  "extensions/memory/context-lifecycle/signal-detector.ts",
  "extensions/memory/context-manager/handlers/rotation.ts",
  "extensions/memory/context-manager/handlers/tools/context-compress.ts",
];

/** Every production TypeScript file under src/. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
    }
  };
  walk(SRC);
  return out;
}

/**
 * Comments replaced by spaces, newlines kept: line numbers stay the file's own,
 * and a tool name mentioned only in prose-as-comment is not a reference.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out += src[i];
          i++;
          break;
        }
        out += src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Every emitted text unit: one string/template body, or the `+` chain of
 * literals read as the one message they build. The chain is the unit because
 * the agent reads the message, not the literal, and a message whose path is in
 * its second half is no less reachable than one that fits on a line.
 */
function stringLiterals(src) {
  const parts = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const quoteStart = i;
      const startLine = line;
      let body = "";
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          body += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        if (src[i] === quote) {
          i++;
          break;
        }
        body += src[i];
        i++;
      }
      parts.push({ body, line: startLine, start: quoteStart, end: i });
      continue;
    }
    i++;
  }
  // Merge `a + b` chains: the join is a lone `+` between two literals.
  const merged = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (previous && /^\s*\+\s*$/.test(src.slice(previous.end, part.start))) {
      previous.body += part.body;
      previous.end = part.end;
      continue;
    }
    merged.push({ ...part });
  }
  return merged;
}

/** Registered `context_*` tool names, from their declarations. */
function registeredContextTools(files) {
  const names = new Set();
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const match of src.matchAll(/\bname:\s*"(context_[a-z_]+)"/g)) names.add(match[1]);
  }
  return names;
}

/** Tools declared with `exposure: "deferred"` - the cold set. */
function deferredTools(files) {
  const names = new Set();
  for (const file of files) {
    // Comments are stripped first: a doc line that explains the deferral is not
    // a declaration, and reading one as such would put a name in the cold set
    // that no registration backs.
    const src = stripComments(readFileSync(file, "utf8"));
    for (const match of src.matchAll(/exposure:\s*"deferred"/g)) {
      const head = src.slice(Math.max(0, match.index - 400), match.index);
      const declared = [...head.matchAll(/\bname:\s*"([a-z][a-z_0-9]*)"/g)].pop();
      assert.ok(
        declared,
        `${relative(SRC, file)}: an exposure:"deferred" without a name before it - the cold set cannot be derived`,
      );
      names.add(declared[1]);
    }
  }
  return names;
}

const ALL_FILES = sourceFiles();
const CONTEXT_TOOLS = registeredContextTools(ALL_FILES);
const COLD_TOOLS = deferredTools(ALL_FILES);
const DISCOVERY = "tool_search";

/** Rule R: a prose string naming a cold context tool must name the discovery path. */
function proseViolations(src) {
  const violations = [];
  for (const literal of stringLiterals(src)) {
    if (!/\s/.test(literal.body)) continue; // an identifier, not advice
    for (const match of literal.body.matchAll(/context_[a-z_]+/g)) {
      const name = match[0];
      if (!CONTEXT_TOOLS.has(name) || !COLD_TOOLS.has(name)) continue;
      if (literal.body.includes(DISCOVERY)) continue;
      violations.push({ line: literal.line, name, kind: "prose", snippet: literal.body.trim().slice(0, 120) });
    }
  }
  return violations;
}

/** Rule S: a `tool: "<name>"` advice field must name a tool on the default surface. */
function fieldViolations(src) {
  const violations = [];
  for (const match of src.matchAll(/\btool:\s*"([a-z][a-z_0-9]*)"/g)) {
    const name = match[1];
    if (!CONTEXT_TOOLS.has(name) || !COLD_TOOLS.has(name)) continue;
    const line = src.slice(0, match.index).split("\n").length;
    violations.push({ line, name, kind: "field", snippet: `tool: "${name}"` });
  }
  return violations;
}

function scan(text) {
  const stripped = stripComments(text);
  return [...proseViolations(stripped), ...fieldViolations(stripped)];
}

test("the rule fires on a bare cold name and stays quiet on the reachable forms", () => {
  // Vacuity guard: the derivation must find the tools the rule is about.
  assert.ok(CONTEXT_TOOLS.size >= 4, `expected the four context tools, got ${[...CONTEXT_TOOLS]}`);
  assert.ok(
    COLD_TOOLS.has("context_inspect") && COLD_TOOLS.has("context_proposals"),
    `the cold set lost the context tools it must contain: ${[...COLD_TOOLS]}`,
  );

  const planted = 'const msg = "Inspect with context_inspect for the full audit.";';
  const withPath = 'const msg = "context_inspect (cold tool: tool_search first).";';
  const live = 'const msg = "Archive with context_compress(action=\\"archive\\") when done.";';
  const field = 'const details = { nextStep: { tool: "context_inspect", detail: "quick" } };';

  assert.equal(scan(planted).length, 1, "a bare cold name in prose must report");
  assert.equal(scan(withPath).length, 0, "the same name with its discovery path must pass");
  assert.equal(scan(live).length, 0, "a default-surface tool may be named bare");
  assert.equal(scan(field).length, 1, "a structured tool field naming a cold tool must report");
});

test("no advisory on the owned surface names a cold context tool without its path", () => {
  const violations = [];
  let proseHits = 0;

  for (const rel of SURFACE) {
    const file = join(SRC, rel);
    statSync(file); // a renamed file is a failure, not a silently empty scan
    const src = readFileSync(file, "utf8");
    const stripped = stripComments(src);
    for (const literal of stringLiterals(stripped)) {
      if (!/\s/.test(literal.body)) continue;
      for (const match of literal.body.matchAll(/context_[a-z_]+/g)) {
        if (CONTEXT_TOOLS.has(match[0])) proseHits++;
      }
    }
    for (const violation of scan(src)) violations.push({ file: rel, ...violation });
  }

  // Population guard: the scan must actually be reading advice. Without this, a
  // refactor that deletes every advisory would make the check pass by emptiness.
  assert.ok(proseHits >= 6, `expected the surface to name context tools in prose, saw ${proseHits}`);

  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.kind} "${v.name}" -> ${v.snippet}`),
    [],
    "every named context tool must be reachable without a tool_search, or carry its path",
  );
});
