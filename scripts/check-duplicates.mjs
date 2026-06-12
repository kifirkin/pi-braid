#!/usr/bin/env node
/**
 * Check for duplicate numeric constants across source files.
 *
 * Flags numeric constants that share the same value AND a similar name
 * across different module directories - these are likely accidental
 * duplications that should be centralized.
 *
 * Usage: node scripts/check-duplicates.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// ── Find all .ts source files ──────────────────────────────────────────────

function findTsFiles(dir) {
  const files = [];
  try {
    for (const n of readdirSync(dir)) {
      if (n.startsWith(".") || n === "node_modules" || n === "dist") continue;
      const f = join(dir, n);
      if (statSync(f).isDirectory()) files.push(...findTsFiles(f));
      else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) files.push(f);
    }
  } catch { /* */ }
  return files;
}

const SRC = join(ROOT, "src");
const files = findTsFiles(SRC);

// ── Extract numeric constants ──────────────────────────────────────────────

const constNumPattern = /(?:export\s+)?const\s+([A-Z_]+)\s*=\s*(-?\d+[\.\d]*(?:e\d+)?)\s*;?/g;
/** Map value → [{ file, name, line }] */
const byValue = new Map();

for (const f of files) {
  const content = readFileSync(f, "utf-8");
  for (const m of content.matchAll(constNumPattern)) {
    const name = m[1];
    const value = parseFloat(m[2]);
    if (value === 0 || value === 1 || value === -1) continue;
    const lineIdx = content.slice(0, m.index).split("\n").length;
    const rel = relative(ROOT, f);
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push({ file: rel, name, line: lineIdx });
  }
}

// ── Name stem extraction ────────────────────────────────────────────────────

/**
 * Reduce a SCREAMING_SNAKE constant name to its semantic stem.
 * Strips common prefixes (MAX_, MIN_, DEFAULT_), unit suffixes
 * (_MS, _SECONDS, _TURNS, _MB, _BYTES), and qualifiers
 * (_THRESHOLD, _LIMIT, _COUNT, _SIZE, _FACTOR).
 *
 * Returns the stem as a lowercase string.
 * Example: MAX_RETRY_ATTEMPTS → retry_attempts
 *          DEFAULT_SDK_RETRIES → sdk_retries
 */
function nameStem(name) {
  let s = name
    .replace(/^(MAX|MIN|DEFAULT|BASE|USAGE|HYGIENE|ANALYTICS|RATE)_/, "")
    .replace(/(_MS|_SECONDS|_MB|_BYTES|_TURNS|_COUNT|_SIZE|_LIMIT|_FACTOR|_RATIO|_IN_MS)$/, "")
    .replace(/(_THRESHOLD)$/, "")
    .toLowerCase();
  return s;
}

// ── Report ──────────────────────────────────────────────────────────────────

/** Map stem → [{ value, file, name, line }] */
const byStem = new Map();

for (const [value, instances] of byValue) {
  if (instances.length < 2) continue;
  for (const inst of instances) {
    const stem = nameStem(inst.name);
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push({ value, ...inst });
  }
}

let foundDuplicates = false;

for (const [stem, instances] of byStem) {
  // Skip stems with only one instance
  if (instances.length < 2) continue;

  // Check: same stem, same value, across different directories
  const dirs = new Set(instances.map((i) => i.file.split("/").slice(0, 2).join("/")));
  if (dirs.size <= 1) continue;

  // Group by value
  const byGroup = new Map();
  for (const inst of instances) {
    if (!byGroup.has(inst.value)) byGroup.set(inst.value, []);
    byGroup.get(inst.value).push(inst);
  }

  for (const [value, group] of byGroup) {
    const groupDirs = new Set(group.map((i) => i.file.split("/").slice(0, 2).join("/")));
    if (groupDirs.size <= 1) continue;

    foundDuplicates = true;
    const sameName = new Set(group.map((i) => i.name)).size <= 1;
    console.log(
      sameName
        ? `\n🔁 ${group[0].name} = ${value} across ${groupDirs.size} dirs:`
        : `\n🔁 Stem "${stem}" = ${value} across ${groupDirs.size} dirs:`,
    );
    for (const inst of group) {
      console.log(`    ${inst.file}:${inst.line}  ${inst.name}`);
    }
  }
}

if (foundDuplicates) {
  console.log("\n⚠️  Same-named constants with same value across directories - consider centralizing.");
  process.exit(1);
} else {
  console.log("✅ No duplicate constants detected.");
  process.exit(0);
}
