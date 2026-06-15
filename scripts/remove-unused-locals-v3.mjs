#!/usr/bin/env node
/**
 * Remove or rename unused local declarations and parameters flagged by tsc.
 *
 * SAFE PATTERNS handled:
 *   1. Function parameter rename: `function f(pi: T, ...)` → `function f(_pi: T, ...)`
 *      when `pi` is reported as unused. Prefix with underscore to silence.
 *   2. Const declaration with no body references: `const X = ...;` → removed
 *      ONLY when the entire line is the const declaration (not part of a
 *      destructuring pattern).
 *   3. Top-level function/interface declarations: removed if reported as
 *      unused and the entire declaration fits on consecutive lines.
 *   4. Multi-name import: handled by v2 script.
 *
 * SKIPS (do manually):
 *   - Complex declarations (destructuring, spread, generic params)
 *   - Parameters in interface declarations (may be needed for typing)
 *   - Anything in a .d.ts file
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

console.log(`Total errors to handle: ${errors.length}`);

const byFileLine = new Map();
for (const e of errors) {
  const k = `${e.file}:${e.ln}`;
  if (!byFileLine.has(k)) byFileLine.set(k, []);
  byFileLine.get(k).push(e);
}

let renamed = 0;
let removed = 0;
let skipped = 0;

for (const [key, errs] of byFileLine) {
  const [file, lnStr] = key.split(":");
  const ln = parseInt(lnStr);
  if (file.endsWith(".d.ts")) continue;
  let src = readFileSync(file, "utf-8");
  const lines = src.split("\n");
  const line = lines[ln - 1];
  if (!line) continue;

  for (const e of errs) {
    const escaped = e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Pattern: function param at col
    // `  pi: ExtensionAPI,` → `  _pi: ExtensionAPI,`
    if (e.col > 1 && /^\s*(\w+)\s*:/.test(line)) {
      const m = line.match(/^(\s*)(\w+)(\s*:)/);
      if (m && m[2] === e.name) {
        if (!e.name.startsWith("_")) {
          lines[ln - 1] = line.replace(/^(\s*)(\w+)(\s*:)/, `$1_$2$3`);
          renamed++;
        }
        continue;
      }
    }

    // Pattern: const declaration (e.g. `const contextSignalSchema = ...`)
    if (e.col === 7 && new RegExp(`^\\s*const\\s+${escaped}\\s*=`).test(line)) {
      // Find the end of the statement (matching paren/brace, then ;)
      let endLine = ln - 1;
      let depth = 0;
      let inStr = false;
      let strCh = "";
      for (let i = endLine; i < lines.length; i++) {
        for (const c of lines[i]) {
          if (inStr) {
            if (c === "\\") continue;
            if (c === strCh) inStr = false;
            continue;
          }
          if (c === '"' || c === "'" || c === "`") {
            inStr = true;
            strCh = c;
            continue;
          }
          if (c === "(" || c === "{" || c === "[") depth++;
          else if (c === ")" || c === "}" || c === "]") depth--;
        }
        if (depth <= 0 && /;\s*$/.test(lines[i])) {
          endLine = i;
          break;
        }
      }
      for (let i = ln - 1; i <= endLine; i++) lines[i] = "";
      removed++;
      continue;
    }

    // Pattern: function/interface declaration
    if (e.col === 1 || (e.col >= 1 && e.col <= 16)) {
      // `async function checkDecompositionCoverage(...) {` or `interface _X {`
      const fnRe = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`);
      const ifaceRe = new RegExp(`^\\s*(?:export\\s+)?interface\\s+${escaped}\\b`);
      if (fnRe.test(line) || ifaceRe.test(line)) {
        // Find matching closing brace
        let depth = 0;
        let endLine = -1;
        let started = false;
        for (let i = ln - 1; i < lines.length; i++) {
          for (const c of lines[i]) {
            if (c === "{") {
              depth++;
              started = true;
            } else if (c === "}") {
              depth--;
              if (started && depth === 0) {
                endLine = i;
                break;
              }
            }
          }
          if (endLine >= 0) break;
        }
        if (endLine >= 0) {
          for (let i = ln - 1; i <= endLine; i++) lines[i] = "";
          removed++;
          continue;
        }
      }
    }

    skipped++;
  }
  writeFileSync(file, lines.join("\n"));
}

console.log(`Renamed ${renamed} parameters, removed ${removed} declarations, skipped ${skipped}.`);
