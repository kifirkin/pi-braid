#!/usr/bin/env node
/**
 * check-prose-punctuation.mjs — gate on U+2014 EM DASH left in markdown prose.
 *
 * The project's prose rule is a plain hyphen for pauses (the `tone-quality`
 * skill states it). This scanner holds the tree to it: U+2014 in any tracked
 * `.md`, on a body or heading line, is a hit and fails the run.
 *
 * Exit codes:
 *   0 — clean (every U+2014 is in an excluded file/line)
 *   1 — at least one hit
 *   2 — error running the scan
 *
 * Out of scope by design, and why:
 *   - `CHANGELOG.md` — release history is dated prose by design.
 *   - fenced code blocks — a dash inside a sample is code, not prose.
 *   - YAML frontmatter — `description:` feeds the machine-read skill catalog.
 *
 * A hit is resolved one of two ways: rewrite the dash, or add an EXCLUSIONS row
 * with a reason. EXCLUSIONS are (path, match, reason) rows applied before
 * reporting, so the file is the audit of why each remaining glyph stays.
 * Deliberate friction: an exclusion is the only way to silence a hit, and it
 * has to be argued in the source.
 *
 * Scope is not the publish set: repo-only markdown (root `AGENTS.md`,
 * `examples/`, non-shipping `AGENTS.md` files) is read too, because the rule
 * is about prose, not distribution.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedMarkdown, readText, frontmatterEnd } from "./lib/doc-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");

const EM = "\u2014";
const HEADING = /^#{1,6} /;
const FENCE = /^\s*(?:```|~~~)/;

/** Whole-file exclusions; their hits are summarized, never itemized. */
const FILE_EXCLUSIONS = [
  { path: "CHANGELOG.md", reason: "release history is dated prose by design" },
];

/** Line-level exclusions: a single line where the glyph is the subject. */
const LINE_EXCLUSIONS = [
  {
    path: "packages/core/TOOLS.md",
    match: /^\|\s*`[a-z_0-9]+`\s*\|/,
    reason:
      "catalog Reflection cells mirror TOOL_GUIDELINES string literals byte-for-byte (test-tool-pipelines.mjs); a dash here is a prompt string, not prose",
  },
  {
    path: "packages/core/skills/tone-quality/SKILL.md",
    match: /Em dash \(—\)/,
    reason: "names the character under discussion; the glyph is the subject, not a pause",
  },
  {
    path: "packages/telegram/docs/live-update.md",
    match: /TRACKED_DONE_TEXT/,
    reason: "quotes the TRACKED_DONE_TEXT program literal defined in live-update.ts",
  },
];

let files;
try {
  files = trackedMarkdown(root);
} catch (err) {
  console.error(`Prose punctuation gate: ERROR — git ls-files failed: ${err.message}`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`Prose punctuation gate: ERROR — no tracked .md files under ${root}`);
  process.exit(2);
}
const findings = [];
const excludedFiles = new Map(); // FILE_EXCLUSIONS entry -> file count
const excludedHits = new Map(); // LINE_EXCLUSIONS entry -> line count
let scanned = 0;

for (const file of files) {
  const fileExclusion = FILE_EXCLUSIONS.find(
    (e) => file === e.path || file.startsWith(e.path),
  );
  if (fileExclusion) {
    excludedFiles.set(fileExclusion, (excludedFiles.get(fileExclusion) ?? 0) + 1);
    continue;
  }

  const source = readText(root, file);
  if (source === undefined) continue;
  if (!source.includes(EM)) continue;
  scanned++;

  const lines = source.split("\n");
  const fmEnd = frontmatterEnd(lines);
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || i <= fmEnd || !line.includes(EM)) continue;

    const lineExclusion = LINE_EXCLUSIONS.find(
      (e) => e.path === file && e.match.test(line),
    );
    if (lineExclusion) {
      excludedHits.set(lineExclusion, (excludedHits.get(lineExclusion) ?? 0) + 1);
      continue;
    }

    findings.push({
      file,
      line: i + 1,
      kind: HEADING.test(line) ? "heading" : "body",
      excerpt: line.trim().slice(0, 100),
    });
  }
}

const byKind = new Map([
  ["heading", []],
  ["body", []],
]);
for (const finding of findings) byKind.get(finding.kind).push(finding);

console.log(`Prose punctuation gate — ${scanned} markdown file(s) carrying U+2014`);

for (const [kind, hits] of byKind) {
  if (hits.length === 0) {
    console.log(`  ${kind}: 0 hits`);
    continue;
  }
  const fileCount = new Set(hits.map((h) => h.file)).size;
  console.log(`  ${kind}: ${hits.length} hit(s) in ${fileCount} file(s)`);
  for (const hit of hits) console.log(`    ${hit.file}:${hit.line}  ${hit.excerpt}`);
}

const allExclusions = [...FILE_EXCLUSIONS, ...LINE_EXCLUSIONS];
const excludedTotal =
  [...excludedFiles.values()].reduce((a, b) => a + b, 0) +
  [...excludedHits.values()].reduce((a, b) => a + b, 0);
if (allExclusions.length > 0) {
  console.log(`\n  Documented exclusions (${allExclusions.length}):`);
  for (const [entries, counts, unit] of [
    [FILE_EXCLUSIONS, excludedFiles, "file(s)"],
    [LINE_EXCLUSIONS, excludedHits, "hit(s)"],
  ]) {
    for (const entry of entries) {
      const count = counts.get(entry) ?? 0;
      console.log(`    ${entry.path} — ${count} ${unit}`);
      console.log(`      reason: ${entry.reason}`);
    }
  }
  console.log(`  Excluded files+hits: ${excludedTotal}`);
}

console.log(`\n  Totals: ${findings.length} hit(s), ${excludedTotal} excluded`);

if (findings.length > 0) {
  console.log(
    `\n  Prose punctuation gate: FAIL (${findings.length} hit(s); use a hyphen, or add an EXCLUSIONS row with a reason)`,
  );
  process.exit(1);
}

console.log("\n  Prose punctuation gate: PASS (0 hits)");
