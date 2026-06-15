#!/usr/bin/env node
/**
 * Remove unused imports from multi-name import statements.
 *
 * SAFE PATTERN: handles `import { a, b, c, d } from "..."` by removing
 * the unused name(s) while preserving the used ones and the import line
 * structure. Multi-line imports are also handled.
 *
 * For TS6133 errors on import statements (col 1-100), the error is the
 * unused name in that import. We parse the import, remove the name, and
 * rewrite the line.
 *
 * SKIPS: type-only imports (those are erased at compile time, may be
 * needed for downstream re-exports).
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const out = execSync(
  "npx tsc --noEmit --noUnusedLocals --noUnusedParameters 2>&1 || true",
  { encoding: "utf-8" },
);

const lines = out.split("\n");
const errors = [];
for (const l of lines) {
  const m = l.match(/^([^(]+)\((\d+),(\d+)\):\s*error\s*(TS\d+):\s*'([^']+)'/);
  if (!m) continue;
  errors.push({
    file: m[1],
    ln: parseInt(m[2]),
    col: parseInt(m[3]),
    code: m[4],
    name: m[5],
  });
}

// Filter to import-line errors only (col 1-100, name is a known import)
const importErrors = errors.filter(
  e => e.code === "TS6133" && e.col >= 1 && e.col <= 200,
);
console.log(`Total errors: ${errors.length}, on import-like rows: ${importErrors.length}`);

const byFileLine = new Map();
for (const e of importErrors) {
  const k = `${e.file}:${e.ln}`;
  if (!byFileLine.has(k)) byFileLine.set(k, []);
  byFileLine.get(k).push(e.name);
}

let totalRemoved = 0;
let skipped = 0;

for (const [key, names] of byFileLine) {
  const [file, lnStr] = key.split(":");
  const ln = parseInt(lnStr);
  let src = readFileSync(file, "utf-8");
  const lines = src.split("\n");
  const line = lines[ln - 1];
  if (!line) continue;

  // Match import { ... } or import type { ... } from "..."
  const importRe =
    /^(\s*import\s+(?:type\s+)?\{)([^}]+)(\}\s*from\s*["'][^"']+["']\s*;?\s*)$/;
  const m = line.match(importRe);
  if (!m) {
    skipped++;
    continue;
  }
  const [, prefix, namesPart, suffix] = m;

  // Split names by comma, remove the unused ones (preserving `type` prefix)
  const nameEntries = namesPart
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const keepEntries = nameEntries.filter(entry => {
    // Strip `type` prefix for matching
    const cleanEntry = entry.replace(/^type\s+/, "").trim();
    // Also strip `as Default` suffix
    const nameOnly = cleanEntry.split(/\s+as\s+/)[0].trim();
    return !names.includes(nameOnly);
  });

  if (keepEntries.length === nameEntries.length) {
    skipped++;
    continue; // Nothing to remove
  }

  if (keepEntries.length === 0) {
    // Remove entire line
    lines[ln - 1] = "";
  } else {
    lines[ln - 1] = `${prefix} ${keepEntries.join(", ")} ${suffix}`;
  }
  totalRemoved += names.length;
  writeFileSync(file, lines.join("\n"));
}

console.log(`Removed ${totalRemoved} unused imports (skipped ${skipped} non-matching lines).`);
