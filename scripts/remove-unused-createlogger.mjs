#!/usr/bin/env node
/**
 * Remove unused `createLogger` imports flagged by tsc.
 *
 * SAFE PATTERN: removes `createLogger` from the import list when it's
 * the only unused import, OR when the resulting import list is empty.
 *
 * Does NOT touch imports with multiple names. Those are left for manual
 * review.
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

const target = errors.filter(e => e.name === "createLogger" && e.col === 1);
console.log(`Found ${target.length} unused createLogger imports.`);

const byFile = new Map();
for (const e of target) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

let total = 0;
let skipped = 0;
for (const [file, items] of byFile) {
  let src = readFileSync(file, "utf-8");
  const lines = src.split("\n");
  for (const item of items) {
    const lineIdx = item.ln - 1;
    if (lineIdx >= lines.length) continue;
    const line = lines[lineIdx];
    // Match `import { createLogger } from "..."` (only createLogger in list)
    if (/^\s*import\s*\{\s*createLogger\s*\}\s*from\s*["'][^"']+["']\s*;?\s*$/.test(line)) {
      lines[lineIdx] = "";
      total++;
    } else {
      skipped++;
    }
  }
  writeFileSync(file, lines.join("\n"));
}

console.log(`Removed ${total} unused createLogger imports (skipped ${skipped} multi-name imports).`);
