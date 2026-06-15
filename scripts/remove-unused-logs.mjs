#!/usr/bin/env node
/**
 * Remove unused `log` imports flagged by tsc.
 *
 * SAFE PATTERN: only handles the exact form:
 *   import { createLogger } from "...";
 *   const log = createLogger("...");
 * where `log` is reported as unused.
 *
 * Removes ONLY the `const log = ...` line, leaving the import intact
 * (in case other code in the file might add log calls later).
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

// Filter to only "log" unused
const logOnly = errors.filter(e => e.name === "log" && e.col === 7);
console.log(`Found ${logOnly.length} unused log declarations.`);

const byFile = new Map();
for (const e of logOnly) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

let total = 0;
for (const [file, items] of byFile) {
  let src = readFileSync(file, "utf-8");
  const lines = src.split("\n");
  for (const item of items) {
    const lineIdx = item.ln - 1;
    if (lineIdx >= lines.length) continue;
    const line = lines[lineIdx];
    // Strict match: exactly `const log = createLogger(...);`
    if (/^\s*const\s+log\s*=\s*createLogger\s*\(/.test(line)) {
      lines[lineIdx] = "";
      total++;
    } else {
      console.log(`  SKIP ${file}:${item.ln} - line does not match pattern: ${line.trim()}`);
    }
  }
  writeFileSync(file, lines.join("\n"));
}

console.log(`Removed ${total} unused log declarations.`);
