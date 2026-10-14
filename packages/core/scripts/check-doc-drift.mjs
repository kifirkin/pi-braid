#!/usr/bin/env node
/**
 * Doc ↔ Code Drift Detector
 *
 * Two checks:
 *
 * 1. Tracked names: for each "tracked API name", count how many .md files
 *    reference it vs how many .ts files reference it. Report asymmetries:
 *
 *   doc-only   — referenced in docs but not in code
 *                → likely forward-looking; check the doc's status marker
 *                  (`<!-- status: forward-looking -->` is OK; otherwise
 *                  this is a doc lying about current behavior)
 *
 *   code-only  — referenced in code but not in docs
 *                → undocumented public surface; consider adding a note
 *
 * Why this exists: target-state documentation getting committed as if it
 * were current-state documentation is the failure mode this gates. The
 * pi-ai v0.80 audit (docs/HOOKS-AND-WHISPERS-AUDIT.md) was the live example:
 * it described llm-call.ts as "Wraps pi.getModel() + streamSimple. Broken
 * on pi-ai v0.80" while the actual code still uses completeSimple from
 * the top-level import. The audit was forward-looking, the code was
 * current — the gap was invisible because no one greps docs against code.
 *
 * 2. Source claims: every row of SOURCE_CLAIMS below pins a number a
 *    document states to a value recomputed from its source of truth (a
 *    manifest, a marked table, or frontmatter). Only claims with a cheap
 *    deterministic extractor belong there; prose claims stay out.
 *
 * Tracked names live in TRACKED_NAMES below. Add to this list when a new
 * public API or external dependency starts appearing in docs. Add a claim
 * to SOURCE_CLAIMS when a doc states a number a file already knows.
 *
 * Usage: node scripts/check-doc-drift.mjs
 * Exit code: 0 = no current-state drift, 1 = current-state drift detected.
 *
 * Notes:
 *   - Docs marked `<!-- status: forward-looking -->` (or aspirational /
 *     historical) are allowed to reference names not yet in code.
 *   - Code-only entries are reported as informational, not failures
 *     (extending docs is a judgment call, not a hard rule).
 *   - A source-claim row fails both when the stated number is wrong and
 *     when the claim pattern no longer matches: a missing claim means the
 *     table stopped covering something it was written for.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectFiles } from "./lib/collect-files.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Tracked API names. Add a name here when:
 *   - It appears in docs but not code (forward-looking), or
 *   - It's a public API surface that should be documented, or
 *   - It's a stable external dependency name (e.g. pi-ai exports)
 *     that the project leans on.
 */
const TRACKED_NAMES = [
  // pi-ai v0.80 migration — the live drift problem
  "completeSimple", // still called directly by telegram notify
  "streamSimple", // the auxiliary-call dispatch path (lib/ai/llm-call.ts)
  "__setCompleteSimpleForTest", // test injection hook (code-only today)
  "createModels", // used by lib/ai/models-init.ts
  "Models", // pi-ai interface name
  // ...extend as new drift surfaces emerge
];

const STATUS_RE = /<!--\s*status:\s*(\S+)\s*-->/;
const NON_CURRENT_STATUSES = new Set(["forward-looking", "aspirational", "historical"]);

// ── File collection ─────────────────────────────────────────────────────────

const TS_FILES = collectFiles(join(ROOT, "src"), (f) => /\.(ts|mts)$/.test(f));
const MD_FILES = [
  ...collectFiles(join(ROOT, "docs"), (f) => f.endsWith(".md")),
  ...collectFiles(join(ROOT, "src"), (f) => {
    const rel = relative(ROOT, f);
    return rel.endsWith(`${sep}AGENTS.md`) || rel === `src${sep}AGENTS.md`;
  }),
];

// ── Per-file mention scan ───────────────────────────────────────────────────

/**
 * Scan a file for whole-word occurrences of a tracked name. Returns the
 * set of 1-indexed line numbers where the name appears.
 */
function findMentions(file, name) {
  const text = readFileSync(file, "utf8");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word boundary: a name like "Models" must not match "ModelResolver".
  const re = new RegExp(`\\b${escaped}\\b`, "g");
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) out.push(i + 1);
    re.lastIndex = 0;
  }
  return out;
}

function getDocStatus(file) {
  const text = readFileSync(file, "utf8");
  const head = text.split("\n").slice(0, 80).join("\n");
  const m = head.match(STATUS_RE);
  return m ? m[1].toLowerCase() : null;
}

// ── Source claims ───────────────────────────────────────────────────────────

/**
 * Each row pins a claim a doc makes to its source of truth:
 *   doc       — repo-relative path of the doc stating the claim
 *   claim     — pattern whose first capture group is the stated value
 *   extractor — recomputes the true value from the source
 *
 * Contract: the pattern must match at least once (a reworded or removed
 * claim fails — the table no longer covers what it was written for), and
 * every match must equal the extracted value. When a claim moves, update
 * the pattern in the same commit.
 */
const REPO_URL = new URL("../../../", import.meta.url);
const repoFile = (rel) => readFileSync(new URL(rel, REPO_URL), "utf8");
const repoJson = (rel) => JSON.parse(repoFile(rel));

/** Source of truth: packages/contrib/package.json → pi.extensions. */
const contribExtensionCount = () => repoJson("packages/contrib/package.json").pi.extensions.length;

/** Source of truth: package.json (repo root) → workspaces. */
const workspaceCount = () => repoJson("package.json").workspaces.length;

/**
 * Source of truth: packages/core/TOOLS.md → the catalog rows (one per
 * documented tool) between the markers. Null when the markers are gone, so a
 * caller reports a missing catalog rather than a count.
 */
function catalogRows() {
  const block = repoFile("packages/core/TOOLS.md").match(
    /<!-- TOOLS-CATALOG-BEGIN -->([\s\S]*?)<!-- TOOLS-CATALOG-END -->/,
  );
  if (!block) return null;
  return block[1].split("\n").filter((line) => /^\|\s*`[^`]+`/.test(line));
}

/** Source of truth: packages/core/TOOLS.md → rows between the catalog markers. */
function catalogToolCount() {
  const rows = catalogRows();
  return rows === null ? -1 : rows.length;
}

/** A catalog row's enablement cell (field 3 of 4) - the class signal. */
function enablementCell(row) {
  return row.split("|")[3] ?? "";
}

/**
 * Class signal: a row whose enablement cell names a pi-core builtin is a tool
 * pi supplies, surfaced by this package - not one braid registers itself.
 */
const PI_CORE_BUILTIN_RE = /\bpi-core builtin\b/;

/** Source of truth: catalog rows pi-core supplies (the native class). */
function catalogBuiltinCount() {
  const rows = catalogRows();
  return rows === null ? -1 : rows.filter((r) => PI_CORE_BUILTIN_RE.test(enablementCell(r))).length;
}

/** Its complement: catalog rows this package registers via `pi.registerTool()`. */
function catalogBraidRegisteredCount() {
  const rows = catalogRows();
  return rows === null ? -1 : rows.filter((r) => !PI_CORE_BUILTIN_RE.test(enablementCell(r))).length;
}

/** Source of truth: `verdict:` values in packages/skills/skills/<name>/SKILL.md. */
function observedVerdicts() {
  const dir = new URL("packages/skills/skills/", REPO_URL);
  const values = new Set();
  for (const name of readdirSync(dir)) {
    let text;
    try {
      text = readFileSync(new URL(`${name}/SKILL.md`, dir), "utf8");
    } catch {
      continue; // _shared and other non-skill directories have no SKILL.md
    }
    const m = text.match(/^verdict:\s*(\S+)\s*$/m);
    if (m) values.add(m[1]);
  }
  return [...values].sort().join(" / ");
}

const SOURCE_CLAIMS = [
  // Contrib extension count: packages/contrib/package.json → pi.extensions
  {
    doc: "AGENTS.md",
    claim: /standalone pi-braid-contrib extensions, (\d+) modules/,
    extractor: contribExtensionCount,
  },
  {
    doc: "packages/core/TOOLS.md",
    claim: /Its (\d+) extensions are all enabled/,
    extractor: contribExtensionCount,
  },
  { doc: "packages/core/TOOLS.md", claim: /(\d+) extensions\s+\|/, extractor: contribExtensionCount },
  {
    doc: "packages/contrib/index.ts",
    claim: /Loads all (\d+) contrib extensions/,
    extractor: contribExtensionCount,
  },
  {
    doc: "packages/contrib/index.ts",
    claim: /\(all (\d+) listed/,
    extractor: contribExtensionCount,
  },
  {
    doc: "packages/contrib/AGENTS.md",
    claim: /all (\d+) are listed individually/,
    extractor: contribExtensionCount,
  },
  {
    doc: "packages/contrib/AGENTS.md",
    claim: /all (\d+) listed individually/,
    extractor: contribExtensionCount,
  },
  {
    doc: "packages/contrib/README.md",
    claim: /(\d+) focused extensions/,
    extractor: contribExtensionCount,
  },
  {
    doc: "packages/contrib/README.md",
    claim: /all (\d+) entry files/,
    extractor: contribExtensionCount,
  },
  {
    doc: "packages/contrib/README.md",
    claim: /(\d+) extensions, each loadable individually/,
    extractor: contribExtensionCount,
  },
  {
    doc: "examples/README.md",
    claim: /pi loads all (\d+) extensions directly/,
    extractor: contribExtensionCount,
  },

  // Package workspaces: package.json (repo root) → workspaces
  {
    doc: "packages/core/docs/ROADMAP.md",
    claim: /all (\d+) packages/,
    extractor: workspaceCount,
  },

  // Core catalog size: packages/core/TOOLS.md → rows between the markers
  {
    doc: "packages/core/TOOLS.md",
    claim: /Documented catalog\*\*\s*\|\s*\*\*(\d+)\*\*/,
    extractor: catalogToolCount,
  },
  {
    doc: "packages/core/src/extensions/context-management/README.md",
    claim: /documents (\d+) tools/,
    extractor: catalogToolCount,
  },
  // The catalog's class rows. Each is recomputed from the catalog's own
  // enablement cells, so they fail both on a stale number and when the two
  // rows stop summing to the documented-catalog row above them.
  {
    doc: "packages/core/TOOLS.md",
    claim: /Braid-registered tools\s*\|\s*(\d+)/,
    extractor: catalogBraidRegisteredCount,
  },
  {
    doc: "packages/core/TOOLS.md",
    claim: /pi-native core tools\s*\|\s*(\d+)/,
    extractor: catalogBuiltinCount,
  },
  // The same split, restated in the core package contract.
  {
    doc: "packages/core/AGENTS.md",
    claim: /(\d+) documented tools:/,
    extractor: catalogToolCount,
  },
  {
    doc: "packages/core/AGENTS.md",
    claim: /documented tools:\s*(\d+) braid-registered/,
    extractor: catalogBraidRegisteredCount,
  },
  {
    doc: "packages/core/AGENTS.md",
    claim: /(\d+) pi-native core builtins/,
    extractor: catalogBuiltinCount,
  },

  // Skills verdict enum: packages/skills/skills/*/SKILL.md frontmatter
  {
    doc: "packages/skills/README.md",
    claim: /`verdict:` field \(([^)]+)\)/,
    extractor: observedVerdicts,
  },
];

/** Check one row; ok=false carries why (wrong value, claim missing, unreadable). */
function checkSourceClaim(row) {
  let text, expected;
  try {
    text = repoFile(row.doc);
    expected = row.extractor();
  } catch (err) {
    return { ok: false, doc: row.doc, detail: `unreadable or extractor failed (${err.message})` };
  }
  // Whitespace-insensitive: prose wraps across lines, so collapse every
  // whitespace run to one space, keeping the source line of each character.
  const norm = [];
  const normLine = [];
  let lineNo = 1;
  let space = false;
  for (const ch of text) {
    if (ch === "\n") {
      lineNo++;
      space = true;
      continue;
    }
    if (/\s/.test(ch)) {
      space = true;
      continue;
    }
    if (space && norm.length > 0) {
      norm.push(" ");
      normLine.push(lineNo);
    }
    space = false;
    norm.push(ch);
    normLine.push(lineNo);
  }
  const found = [];
  for (const m of norm.join("").matchAll(new RegExp(row.claim.source, "g"))) {
    found.push({ line: normLine[m.index], value: m[1] });
  }
  if (found.length === 0) {
    return {
      ok: false,
      doc: row.doc,
      detail: `claim ${row.claim} not found; reworded or removed, update SOURCE_CLAIMS`,
    };
  }
  const bad = found.filter((f) => String(f.value) !== String(expected));
  return {
    ok: bad.length === 0,
    doc: row.doc,
    expected: String(expected),
    found,
    bad,
  };
}

// ── Derived doc references ──────────────────────────────────────────────────
//
// The tracked-name list is hand-kept: a name enters it only when someone adds
// it, so a doc can reference a symbol that exists nowhere and no gate notices.
// This half derives the subject set instead. Every identifier-shaped token in
// a backticked span of a tracked doc is a reference; it must resolve against
// the repository's own source. The escape hatch is an inline annotation the
// doc carries next to the claim:
//
//     <!-- doc-ref-exempt: removed in the context-tool consolidation -->
//
// An annotation excuses the unresolved references on its own line, and the
// output lists and counts every excused reference, so an excused name can
// never hide. Two recorded sets cover the rest: DOC_REF_EXTERNAL names the
// host- and package-provided surface a doc may legitimately name, and
// DOC_REF_KNOWN records unresolved references in current-state docs as queued
// fixes. The check fails when a row in either set stops matching, so the
// commit that repairs a reference deletes its row in the same change. A doc
// whose status is forward-looking, aspirational or historical is advisory.

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The running checker's own source. Its recorded tables are data, not
 * subject matter - a name spelled in DOC_REF_KNOWN or DOC_REF_EXTERNAL must
 * not resolve against its own row - so the haystack reader masks exactly
 * those names in this file and leaves everything else (TRACKED_NAMES, the
 * claim extractors) resolving like ordinary code.
 */
const DOC_REF_SELF = fileURLToPath(import.meta.url);

/** Inline annotation that excuses the unresolved references on its line. */
const DOC_REF_EXEMPT_RE = /<!--\s*doc-ref-exempt:\s*([\s\S]*?)\s*-->/;

/**
 * Identifier shapes the doc-reference scan keeps: camelCase, CONSTANT_CASE,
 * snake_case, an API-suffix family, or a long name. Plain lowercase words are
 * prose, and the shapes the rule drops (paths, commands, flags, JSON
 * fragments, file names) are not claims about a code symbol.
 */
const DOC_REF_SHAPE = (id) =>
  !/\d/.test(id) &&
  (/[a-z][A-Z]/.test(id) ||
    /^[A-Z][A-Z0-9_]{2,}$/.test(id) ||
    /^[a-z]+(_[a-z0-9]+){1,}$/.test(id) ||
    /(File|Path|Dir|State|Config|Manager|Builder|Handler|Store|Registry|Tool|Section|Counter|Limit|Rule|Gate|Check|Chain|Notice|Advisory)$/.test(id) ||
    id.length >= 16);

/**
 * Host- and package-provided names a doc may legitimately name, each with the
 * surface it belongs to. External names only: a name this repository owns is
 * either derived from the source or recorded in DOC_REF_KNOWN.
 */
const DOC_REF_EXTERNAL = [
  ...[
    "PI_PACKAGE_DIR",
    "PI_OFFLINE",
    "PI_SKIP_VERSION_CHECK",
    "PI_CACHE_RETENTION",
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
    "AI_AGENT",
    "PI_CODING_AGENT",
    "ANTHROPIC_API_KEY",
  ].map((name) => ({ name, reason: "host environment variable read by the pi CLI" })),
  ...[
    "web_search",
    "fetch_content",
    "source_check",
    "get_search_content",
    "web_enable",
  ].map((name) => ({ name, reason: "tool provided by the pi-web-access package" })),
  { name: "responseId", reason: "argument of the pi-web-access result reader" },
  { name: "web_fetch", reason: "host web fetch tool named in release history" },
  ...[
    "analyze_image",
    "read_document",
    "render_pdf_page",
    "compare_images",
    "browser_upload_image",
  ].map((name) => ({ name, reason: "tool provided by an installed pi package" })),
  { name: "in_reply_to", reason: "X intent-URL parameter named by the twitter skill" },
  { name: "time_range", reason: "date-window argument of the host search tools" },
  { name: "workspace_create", reason: "tool provided by the herdr package" },
  { name: "tab_create", reason: "tool provided by the herdr package" },
  { name: "agent_blocked", reason: "pane lifecycle status reported by the herdr package" },
  { name: "wait_agent", reason: "tool name from the herdr package" },
  { name: "agent_get", reason: "tool name from the herdr package" },
  { name: "LOOP_DETECTED", reason: "orchestrator loop signal named by the skill" },
];

/**
 * Known unresolved references in current-state docs: each row is a queued
 * documentation fix, recorded so the check lands before the repair does.
 * Keyed by doc and identifier (line numbers move). The check fails when a row
 * stops matching.
 */
const DOC_REF_KNOWN = [
  {
    doc: "packages/core/AGENTS.md",
    token: "determineContrastMode",
    reason: "the signals row names an API the enforcement extension does not export",
  },
  {
    doc: "packages/core/CONTRIBUTING.md",
    token: "behaviorModeSection",
    reason: "names a tracked name the checker's own list does not carry",
  },
  {
    doc: "packages/core/src/extensions/enforcement/handlers/AGENTS.md",
    token: "before_tool_call",
    reason: "the extension registers tool_call, not before_tool_call",
  },
  {
    doc: "packages/core/src/lib/ai/AGENTS.md",
    token: "withTypeBox",
    reason: "the classifier has no withTypeBox schema helper",
  },
  {
    doc: "packages/core/src/lib/state/AGENTS.md",
    token: "_shownDiscoveryBundles",
    reason: "the dedup slot is a globalThis key, not this binding",
  },
  {
    doc: "packages/core/src/lib/state/AGENTS.md",
    token: "setLogLevel",
    reason: "the logger exposes setLoggerContext, not setLogLevel",
  },
  {
    doc: "packages/core/src/lib/types/AGENTS.md",
    token: "typeRoot",
    reason: "the compiler option is typeRoots; the row names a typeRoot",
  },
];

/** The doc's current-state marker, or null when it carries none. */
function docStatusOf(text) {
  const head = text.split("\n").slice(0, 80).join("\n");
  const m = head.match(STATUS_RE);
  return m ? m[1].toLowerCase() : null;
}

/** A whole-word test for an identifier inside the haystack. */
function haystackMentions(haystack, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

/**
 * Run the derived doc-reference check against a tree. Returns every finding
 * class plus an exit code; the caller prints them.
 */
export function checkDocReferences({
  repoRoot,
  external = DOC_REF_EXTERNAL,
  known = DOC_REF_KNOWN,
} = {}) {
  const docs = collectFiles(repoRoot, (f) => f.endsWith(".md"));
  const code = collectFiles(repoRoot, (f) => /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|json|jsonl)$/.test(f));
  let haystack = "";
  const recordedNames = [...new Set([...external.map((row) => row.name), ...known.map((row) => row.token)])];
  for (const file of code) {
    try {
      const st = statSync(file);
      if (st.size > 4_000_000) continue;
      let text = readFileSync(file, "utf8");
      // This file's own tables are data, not implementations: a name recorded
      // here must not resolve against its own row. Everything else in the
      // checker's source is ordinary code and resolves like any other file.
      if (file === DOC_REF_SELF) {
        for (const name of recordedNames) text = text.split(name).join(" ".repeat(name.length));
      }
      haystack += text + "\n";
    } catch {
      /* an unreadable file subtracts from the haystack, never from the scan */
    }
  }
  const externalByName = new Map(external.map((row) => [row.name, row]));

  const findings = [];
  let spans = 0;
  let considered = 0;
  for (const file of docs) {
    const text = readFileSync(file, "utf8");
    const status = docStatusOf(text);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const exemptMatch = line.match(DOC_REF_EXEMPT_RE);
      for (const span of line.matchAll(/`([^`\n]+)`/g)) {
        spans++;
        const raw = span[1].trim();
        const id = raw.replace(/\(\)$/, "").replace(/^\.+/, "");
        if (/[ /\\]/.test(id) || /^--/.test(id) || /[{}"'=:()<>|]/.test(id)) continue;
        if (/\.(ts|js|mjs|json|md|jsonl|d\.ts)$/.test(id)) continue;
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) continue;
        if (/^[a-z0-9-]+$/.test(id)) continue;
        if (!DOC_REF_SHAPE(id)) continue;
        considered++;
        if (haystackMentions(haystack, id)) continue;
        findings.push({
          doc: relative(repoRoot, file),
          line: i + 1,
          token: id,
          raw,
          status,
          exempt: exemptMatch ? exemptMatch[1].trim() : null,
        });
      }
    });
  }

  const advisory = [];
  const excused = [];
  const externalRefs = [];
  const knownRefs = [];
  const unresolved = [];
  const matchedKnown = new Set();
  for (const finding of findings) {
    if (finding.status && NON_CURRENT_STATUSES.has(finding.status)) {
      advisory.push(finding);
      continue;
    }
    if (finding.exempt !== null) {
      if (finding.exempt === "") {
        unresolved.push({ ...finding, why: "empty-annotation" });
      } else {
        excused.push({ ...finding, reason: finding.exempt });
      }
      continue;
    }
    if (externalByName.has(finding.token)) {
      externalRefs.push({ ...finding, reason: externalByName.get(finding.token).reason });
      continue;
    }
    const row = known.find((r) => r.doc === finding.doc && r.token === finding.token);
    if (row) {
      matchedKnown.add(row);
      knownRefs.push({ ...finding, reason: row.reason });
      continue;
    }
    unresolved.push({ ...finding, why: "unresolved-reference" });
  }

  // A recorded row that no longer matches is the fix signal: the repair commit
  // deletes the row in the same change. An external name no doc names anymore
  // is debris in the inventory.
  const staleKnown = known.filter((row) => !matchedKnown.has(row));
  const staleExternal = external.filter((row) => {
    for (const file of docs) {
      const text = readFileSync(file, "utf8");
      if (haystackMentions(text, row.name)) return false;
    }
    return true;
  });

  const exitCode = unresolved.length > 0 || staleKnown.length > 0 || staleExternal.length > 0 ? 1 : 0;
  return {
    exitCode,
    docs: docs.length,
    spans,
    considered,
    findings,
    advisory,
    excused,
    externalRefs,
    knownRefs,
    unresolved,
    staleKnown,
    staleExternal,
    rows: { external: external.length, known: known.length },
  };
}

/** Print the derived doc-reference result; returns 0 or 1. */
function reportDocReferences(result) {
  if (result.unresolved.length > 0) {
    console.error(`❌ Unresolved doc references in current-state docs (${result.unresolved.length}):\n`);
    for (const finding of result.unresolved) {
      const hint =
        finding.why === "empty-annotation"
          ? "annotation carries no reason; state why the name is deliberately unreferenced"
          : "resolve the token, annotate the line `<!-- doc-ref-exempt: <reason> -->`, or record a row in DOC_REF_KNOWN";
      console.error(`  ${finding.doc}:${finding.line}  ${finding.token}`);
      console.error(`    ${hint}`);
    }
    console.error();
  }

  if (result.staleKnown.length > 0) {
    console.error(`❌ Known-reference rows that no longer match (${result.staleKnown.length}) - delete the row with the repair:\n`);
    for (const row of result.staleKnown) {
      console.error(`  ${row.doc}  ${row.token}  (${row.reason})`);
    }
    console.error();
  }

  if (result.staleExternal.length > 0) {
    console.error(`❌ External names no doc references anymore (${result.staleExternal.length}) - delete the row:\n`);
    for (const row of result.staleExternal) {
      console.error(`  ${row.name}  (${row.reason})`);
    }
    console.error();
  }

  if (result.excused.length > 0) {
    console.log(`   Excused by annotation (${result.excused.length}):`);
    for (const finding of result.excused) {
      console.log(`     ${finding.doc}:${finding.line}  ${finding.token}  (${finding.reason})`);
    }
  }

  console.log(
    `   Derived doc references: ${result.docs} doc(s), ${result.spans} inline span(s), ${result.considered} identifier(s) considered, ` +
      `${result.findings.length} finding(s) - ${result.advisory.length} advisory (non-current), ${result.excused.length} excused by annotation, ` +
      `${result.externalRefs.length} external (${result.rows.external} name(s)), ${result.knownRefs.length} queued fix(es) (${result.rows.known} row(s)).`,
  );
  return result.exitCode;
}

// ── Aggregate mentions ──────────────────────────────────────────────────────


function runTrackedNameChecks() {
  const report = [];
  for (const name of TRACKED_NAMES) {
    const codeHits = [];
    for (const f of TS_FILES) {
      const lines = findMentions(f, name);
      if (lines.length > 0) {
        codeHits.push({ file: relative(ROOT, f), lines });
      }
    }

    const docHits = [];
    for (const f of MD_FILES) {
      const lines = findMentions(f, name);
      if (lines.length === 0) continue;
      const status = getDocStatus(f);
      docHits.push({ file: relative(ROOT, f), lines, status });
    }

    // Partition docs by status for current-state enforcement.
    const currentDocs = docHits.filter((h) => h.status === "current" || h.status === null);
    const nonCurrentDocs = docHits.filter((h) => NON_CURRENT_STATUSES.has(h.status));

    report.push({ name, codeHits, currentDocs, nonCurrentDocs });
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  let exitCode = 0;
  const driftFailures = [];
  const claimFailures = SOURCE_CLAIMS.map(checkSourceClaim).filter((r) => !r.ok);
  const docOnlyAdvisories = [];
  const codeOnlyAdvisories = [];

  for (const r of report) {
    const codeCount = r.codeHits.reduce((n, h) => n + h.lines.length, 0);
    const currentDocCount = r.currentDocs.reduce((n, h) => n + h.lines.length, 0);
    const nonCurrentDocCount = r.nonCurrentDocs.reduce((n, h) => n + h.lines.length, 0);

    // Hard fail: a `current` (or unmarked) doc references an API name not in code.
    if (currentDocCount > 0 && codeCount === 0) {
      driftFailures.push({ name: r.name, hits: r.currentDocs });
    }

    // Advisory: name is doc-only overall (could be forward-looking only).
    if (codeCount === 0 && currentDocCount + nonCurrentDocCount > 0) {
      docOnlyAdvisories.push({
        name: r.name,
        currentDocs: r.currentDocs,
        nonCurrentDocs: r.nonCurrentDocs,
      });
    }

    // Advisory: name is code-only (potentially undocumented).
    if (codeCount > 0 && currentDocCount === 0 && nonCurrentDocCount === 0) {
      codeOnlyAdvisories.push({ name: r.name, hits: r.codeHits });
    }
  }

  if (driftFailures.length > 0) {
    exitCode = 1;
    console.error(`❌ Current-state drift detected (${driftFailures.length}):\n`);
    for (const f of driftFailures) {
      console.error(`  '${f.name}' is referenced in current-state docs but not in code:`);
      for (const hit of f.hits) {
        console.error(`    ${hit.file}:${hit.lines.join(",")}`);
      }
      console.error();
    }
  }

  if (claimFailures.length > 0) {
    exitCode = 1;
    console.error(`❌ Source claims drifted from their sources (${claimFailures.length}):\n`);
    for (const f of claimFailures) {
      if (f.bad && f.bad.length > 0) {
        console.error(
          `  ${f.doc}: expected ${f.expected}, found ${[...new Set(f.bad.map((b) => b.value))].join(", ")}`,
        );
        for (const b of f.bad) console.error(`    line ${b.line}`);
      } else {
        console.error(`  ${f.doc}: ${f.detail}`);
      }
      console.error();
    }
  }

  if (docOnlyAdvisories.length > 0) {
    console.log(`ℹ️  Doc-only names (${docOnlyAdvisories.length}) — likely forward-looking:`);
    for (const a of docOnlyAdvisories) {
      console.log(`  '${a.name}' — ${a.nonCurrentDocs.length} non-current doc(s) reference it`);
      for (const hit of a.nonCurrentDocs) {
        console.log(`    ${hit.file}:${hit.lines.join(",")} [status: ${hit.status}]`);
      }
    }
    console.log();
  }

  if (codeOnlyAdvisories.length > 0) {
    console.log(`ℹ️  Code-only names (${codeOnlyAdvisories.length}) — possibly undocumented:`);
    for (const a of codeOnlyAdvisories) {
      console.log(`  '${a.name}' — ${a.hits.length} source file(s) use it`);
      for (const hit of a.hits.slice(0, 5)) {
        console.log(`    ${hit.file}:${hit.lines.join(",")}`);
      }
      if (a.hits.length > 5) console.log(`    ... and ${a.hits.length - 5} more`);
    }
    console.log();
  }

  if (exitCode === 0) {
    console.log(
      `✅ No current-state drift. ${TRACKED_NAMES.length} tracked name(s), ${SOURCE_CLAIMS.length} source claim(s) checked.`,
    );
  }
return exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  let exitCode = runTrackedNameChecks();
  const docRefs = checkDocReferences({ repoRoot: REPO });
  if (docRefs.exitCode !== 0) exitCode = 1;
  reportDocReferences(docRefs);
  console.error(`Run: node scripts/check-doc-drift.mjs`);
  process.exit(exitCode);
}
