#!/usr/bin/env node
/**
 * check-doc-dates.mjs — gate on ISO dates in markdown prose that carry no
 * handle a reader of the current tree can act on.
 *
 * An ISO date token (`20xx-xx-xx`) in a tracked `.md` is allowed only when at
 * least one of these holds:
 *   (a) the line sits under a heading matching /^#{1,6} .*[Hh]istory/ — the
 *       documented seat for dated rows (`### Migration history`);
 *   (b) the file is listed in EXCLUSIONS below with a reason — this list is
 *       the audit of why each surviving date is load-bearing (tombstones,
 *       deprecation/merge markers, rename provenance, empirical observations);
 *   (c) the whitespace-delimited word containing the token is a path or a
 *       filename (has an internal `/` or ends in `.md`) — the date is part of
 *       a reference, and editing it would break the reference;
 *   (d) the line is a YAML frontmatter `validated:` field — a documented
 *       schema field consumed by the skills contract;
 *   (e) the line is inside a fenced code block — the `CONTRIBUTING.md`
 *       changelog example, where the date range *is* the documented format.
 *
 * Every non-allowed token is residue: a process timestamp nothing in the tree
 * reads, and it fails the run. A hit is resolved by removing the date or by
 * adding an EXCLUSIONS row with a reason (tombstone, provenance, empirical
 * observation): the row is the audit of why the date is load-bearing.
 *
 * Exit codes:
 *   0 — clean (every ISO date is covered by an allowance)
 *   1 — at least one residue hit
 *   2 — error running the scan
 *
 * Scope is not the publish set: repo-only markdown is read too, or the gate
 * would miss exactly the non-shipping `AGENTS.md` files that carry residue.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedMarkdown, readText, frontmatterEnd } from "./lib/doc-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");

const DATE = /\b20\d\d-\d\d-\d\d\b/g;
const HISTORY_HEADING = /^#{1,6} .*[Hh]istory/;
const HEADING = /^#{1,6} /;
const FENCE = /^\s*(?:```|~~~)/;
const VALIDATED = /^\s*validated:/;

/** (path, reason) rows applied before reporting; a directory prefix excludes all under it. */
const EXCLUSIONS = [
  { path: "CHANGELOG.md", reason: "release history; each dated entry is the record" },
  {
    path: "packages/core/AGENTS.md",
    reason: "the archived tool-inventory audit date is that artifact's only handle",
  },
  {
    path: "packages/core/src/extensions/core/prompt-builder/AGENTS.md",
    reason: "tombstone and Historical-section rows: the dates record which consolidation happened when",
  },
  {
    path: "packages/core/src/extensions/memory/AGENTS.md",
    reason: "the dates explain why cancellation code survives a removed timer, and when a named fixture's claim was verified",
  },
  {
    path: "packages/core/src/extensions/scheduling/timer/AGENTS.md",
    reason: "removed-tag table row and safety-guard prose: the dates explain why dead-looking code remains",
  },
  {
    path: "packages/providers/AGENTS.md",
    reason: "rename provenance: a reader holding an old config needs the change date",
  },
  { path: "packages/providers/README.md", reason: "the same rename record on the consumer surface" },
  {
    path: "packages/skills/README.md",
    reason: "merge, deprecation, and restore provenance for skills absent from the shipped pack",
  },
  { path: "packages/core/skills/code-refactoring/SKILL.md", reason: "merge provenance" },
  {
    path: "packages/core/skills/code-search/SKILL.md",
    reason: "merge-round marker: the record is the stub's whole purpose",
  },
  { path: "packages/skills/skills/meme/SKILL.md", reason: "deprecation marker" },
  { path: "packages/skills/skills/socratic-irony/SKILL.md", reason: "deprecation marker" },
  { path: "packages/skills/skills/twitter/SKILL.md", reason: "deprecation marker" },
  {
    path: "packages/core/skills/herdr-topology/SKILL.md",
    reason: "observation provenance for empirical claims: the date tells a reader whether the evidence is current",
  },
  {
    path: "packages/core/skills/voice-replies/SKILL.md",
    reason: "observation provenance for the edge-tts version floor and retry evidence: the date tells a reader whether the claims are current",
  },
];

/** True when every date token on the line sits inside a path/filename word. */
function onlyInPathTokens(line) {
  let sawDate = false;
  for (const match of line.matchAll(DATE)) {
    sawDate = true;
    const at = match.index;
    let start = at;
    let end = at + match[0].length;
    while (start > 0 && !/\s/.test(line[start - 1])) start--;
    while (end < line.length && !/\s/.test(line[end])) end++;
    const word = line.slice(start, end);
    if (!(word.includes("/") || word.endsWith(".md"))) return false;
  }
  return sawDate;
}

let files;
try {
  files = trackedMarkdown(root);
} catch (err) {
  console.error(`Doc dates gate: ERROR — git ls-files failed: ${err.message}`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`Doc dates gate: ERROR — no tracked .md files under ${root}`);
  process.exit(2);
}
const findings = [];
const excludedCounts = new Map();
let scanned = 0;

for (const file of files) {
  const exclusion = EXCLUSIONS.find(
    (e) => file === e.path || file.startsWith(e.path),
  );
  if (exclusion) {
    excludedCounts.set(exclusion, (excludedCounts.get(exclusion) ?? 0) + 1);
    continue;
  }

  const source = readText(root, file);
  if (source === undefined) continue;
  if (!/\b20\d\d-\d\d-\d\d\b/.test(source)) continue;
  scanned++;

  const lines = source.split("\n");
  const fmEnd = frontmatterEnd(lines);
  let inFence = false;
  let heading = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence && HEADING.test(line)) heading = line;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !/\b20\d\d-\d\d-\d\d\b/.test(line)) continue;
    if (HISTORY_HEADING.test(heading)) continue; // (a)
    if (onlyInPathTokens(line)) continue; // (c)
    if (i <= fmEnd && VALIDATED.test(line)) continue; // (d)

    findings.push({
      file,
      line: i + 1,
      heading: heading.trim().slice(0, 40),
      excerpt: line.trim().slice(0, 100),
    });
  }
}

console.log(`Doc dates gate — ${scanned} markdown file(s) carrying an ISO date`);

if (findings.length > 0) {
  const fileCount = new Set(findings.map((f) => f.file)).size;
  console.log(`  residue: ${findings.length} hit(s) in ${fileCount} file(s)`);
  for (const hit of findings) {
    const at = hit.heading ? ` [${hit.heading}]` : "";
    console.log(`    ${hit.file}:${hit.line}${at}  ${hit.excerpt}`);
  }
} else {
  console.log("  residue: 0 hits");
}

const excludedTotal = [...excludedCounts.values()].reduce((a, b) => a + b, 0);
if (EXCLUSIONS.length > 0) {
  console.log(`\n  Documented exclusions (${EXCLUSIONS.length}):`);
  for (const entry of EXCLUSIONS) {
    const count = excludedCounts.get(entry) ?? 0;
    console.log(`    ${entry.path} — ${count} file(s)`);
    console.log(`      reason: ${entry.reason}`);
  }
  console.log(`  Excluded files: ${excludedTotal}`);
}

console.log(`\n  Totals: ${findings.length} hit(s), ${excludedTotal} file(s) excluded`);

if (findings.length > 0) {
  console.log(
    `\n  Doc dates gate: FAIL (${findings.length} residue hit(s); drop the date, or add an EXCLUSIONS row with a reason)`,
  );
  process.exit(1);
}

console.log("\n  Doc dates gate: PASS (0 residue hits)");
