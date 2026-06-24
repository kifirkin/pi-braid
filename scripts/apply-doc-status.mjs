#!/usr/bin/env node
/**
 * Apply Status Markers (one-shot helper)
 *
 * Inserts `<!-- status: <status> -->` as the first content line of each
 * given file if the marker isn't already present. Idempotent: re-running
 * with the same input is a no-op.
 *
 * This is a utility for the initial bootstrap of the discipline layer.
 * After all docs carry markers, this script should rarely need to run.
 * For future docs, add the marker by hand (or copy from a sibling).
 *
 * Usage: node scripts/apply-doc-status.mjs <manifest.json>
 * Manifest format: { "path/to/doc.md": "current", ... }
 *
 * Exit code: 0 = success, 1 = file read/write failure.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const VALID = new Set(["current", "forward-looking", "aspirational", "historical"]);

const manifestArg = process.argv[2];
if (!manifestArg) {
  console.error("Usage: node scripts/apply-doc-status.mjs <manifest.json>");
  process.exit(1);
}

const absManifest = resolve(ROOT, manifestArg);
const manifest = JSON.parse(readFileSync(absManifest, "utf8"));

let updated = 0;
let skipped = 0;
const failures = [];

for (const [relPath, status] of Object.entries(manifest)) {
  if (!VALID.has(status)) {
    failures.push(`${relPath}: invalid status '${status}'`);
    continue;
  }
  const absPath = resolve(ROOT, relPath);
  let content;
  try {
    content = readFileSync(absPath, "utf8");
  } catch (err) {
    failures.push(`${relPath}: ${err.message}`);
    continue;
  }

  // Skip if marker already present in the first 80 lines.
  const head = content.split("\n").slice(0, 80).join("\n");
  if (/<!--\s*status:\s*\S+\s*-->/.test(head)) {
    skipped++;
    continue;
  }

  const marker = `<!-- status: ${status} -->`;
  const lines = content.split("\n");

  // Insert strategy:
  //   - If the file starts with a Markdown heading (# ...), insert the
  //     marker on a new line BEFORE the heading.
  //   - Otherwise insert at the top.
  // We don't touch YAML frontmatter (this project doesn't use it in
  // these docs, but if it appears, the marker can be hand-placed).
  let insertAt = 0;
  if (lines[0]?.startsWith("# ")) {
    insertAt = 0;
  }

  // Always insert at line 0 with a blank line after for readability.
  lines.splice(insertAt, 0, marker, "");
  const newContent = lines.join("\n");

  try {
    writeFileSync(absPath, newContent, "utf8");
    updated++;
    console.log(`  + ${relPath} → ${status}`);
  } catch (err) {
    failures.push(`${relPath}: ${err.message}`);
  }
}

console.log(`\n${updated} updated, ${skipped} already had markers`);
if (failures.length > 0) {
  console.error(`\nFailures (${failures.length}):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}