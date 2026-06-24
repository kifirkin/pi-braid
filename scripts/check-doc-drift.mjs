#!/usr/bin/env node
/**
 * Doc ↔ Code Drift Detector
 *
 * For each "tracked API name", count how many .md files reference it vs
 * how many .ts files reference it. Report asymmetries:
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
 * Tracked names live in TRACKED_NAMES below. Add to this list when a new
 * public API or external dependency starts appearing in docs.
 *
 * Usage: node scripts/check-doc-drift.mjs
 * Exit code: 0 = no current-state drift, 1 = current-state drift detected.
 *
 * Notes:
 *   - Docs marked `<!-- status: forward-looking -->` (or aspirational /
 *     historical) are allowed to reference names not yet in code.
 *   - Code-only entries are reported as informational, not failures
 *     (extending docs is a judgment call, not a hard rule).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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
  "completeSimple",        // current code API (will relocate in 0.80)
  "streamSimple",          // target API (currently doc-only)
  "__setCompleteSimpleForTest", // test injection hook (code-only today)
  "createModels",          // target API (currently doc-only)
  "Models",                // interface name (target)
  // ...extend as new drift surfaces emerge
];

const STATUS_RE = /<!--\s*status:\s*(\S+)\s*-->/;
const NON_CURRENT_STATUSES = new Set([
  "forward-looking",
  "aspirational",
  "historical",
]);

// ── File collection ─────────────────────────────────────────────────────────

function collectFiles(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of entries) {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
    const f = join(dir, n);
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...collectFiles(f, predicate));
    else if (predicate(f)) out.push(f);
  }
  return out;
}

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

// ── Aggregate mentions ──────────────────────────────────────────────────────

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
  if (codeCount === 0 && (currentDocCount + nonCurrentDocCount) > 0) {
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
  console.log(`✅ No current-state drift. ${TRACKED_NAMES.length} tracked name(s) checked.`);
}

console.error(`Run: node scripts/check-doc-drift.mjs`);
process.exit(exitCode);