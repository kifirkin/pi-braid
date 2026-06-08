/**
 * API Surface Drift Checker
 *
 * Detects changes to exported function/type signatures that would break
 * consumers across module boundaries. Runs as a structural test.
 *
 * Checks:
 *   1. All extension factory functions match standard pattern
 *   2. All CRITICS definitions have .criteria and .label
 *   3. Key shared type exports maintain expected field shapes
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

// ── Check 1: Extension factory signatures ────────────────────────────────────

function checkExtensionFactories(files) {
  const violations = [];
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    const matches = src.match(/export default function \w+\(/g);
    if (!matches) continue;
    for (const m of matches) {
      const name = m.replace("export default function ", "").replace("(", "");
      const piDirect = new RegExp(
        `export default function ${name}\\(\\s*\\w+\\s*:\\s*ExtensionAPI`
      );
      const piFactory = new RegExp(
        `export default function ${name}\\(\\)(:\\s*\\(pi:\\s*ExtensionAPI|\\s*\\{:[^}]+return function\\(pi:\\s*ExtensionAPI)`
      );
      if (!piDirect.test(src) && !piFactory.test(src)) {
        violations.push({ file, func: name, issue: "Signature must take 'pi: ExtensionAPI' or return fn(pi: ExtensionAPI)" });
      }
    }
  }
  return violations;
}

// ── Check 2: CRITICS shape ───────────────────────────────────────────────────

function checkCriticsShape(files) {
  const violations = [];
  for (const file of files) {
    if (!file.endsWith("critic-registry.ts")) continue;
    const src = readFileSync(file, "utf-8");
    const lines = src.split("\n");
    let inCritics = false;
    let braceDepth = 0;
    let currentCritic = "";
    let hasCriteria = false;
    let hasLabel = false;
    let startLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("export const CRITICS = {")) {
        inCritics = true;
        braceDepth = 1;
        currentCritic = "";
        continue;
      }
      if (!inCritics) continue;

      const keyMatch = trimmed.match(/^\s*(\w+):\s*\{/);
      if (keyMatch && braceDepth === 1) {
        if (currentCritic && (!hasCriteria || !hasLabel)) {
          violations.push({ file, line: startLine, critic: currentCritic,
            issue: `Missing ${!hasCriteria ? ".criteria" : ""} ${!hasLabel ? ".label" : ""}` });
        }
        currentCritic = keyMatch[1];
        startLine = i + 1;
        hasCriteria = false;
        hasLabel = false;
      }

      for (const ch of trimmed) { if (ch === "{") braceDepth++; if (ch === "}") braceDepth--; }
      if (trimmed.match(/^\s*criteria:\s*\{/)) hasCriteria = true;
      if (trimmed.match(/^\s*label:\s*"/)) hasLabel = true;

      if (braceDepth <= 0 && currentCritic) {
        if (!hasCriteria || !hasLabel) {
          violations.push({ file, line: startLine, critic: currentCritic,
            issue: `Missing ${!hasCriteria ? ".criteria" : ""} ${!hasLabel ? ".label" : ""}` });
        }
        break;
      }
    }
  }
  return violations;
}

// ── Check 3: Key type exports ────────────────────────────────────────────────

const KEY_TYPES = {
  "lib/ai/critic-registry.ts": ["CRITICS", "CriticDef", "criticLabel"],
  "lib/ai/critic-stats.ts": ["recordCriticCall", "getCriticStats", "resetCriticStats"],
  "lib/ai/text-classifier.ts": ["classify", "ClassifierCriteria", "ClassificationResult"],
  "lib/core/event-names.ts": ["SESSION_START", "SESSION_END", "TURN_END", "TOOL_CALL"],
  "lib/state/extension-state.ts": ["getExtensionState"],
  "lib/events/event-types.ts": ["onEvent"],
};

function checkKeyTypeExports(filesByRel) {
  const violations = [];
  for (const [relPath, expectedExports] of Object.entries(KEY_TYPES)) {
    const absPath = filesByRel[relPath];
    if (!absPath) { violations.push({ file: relPath, issue: "FILE NOT FOUND" }); continue; }
    const src = readFileSync(absPath, "utf-8");
    for (const exp of expectedExports) {
      // Accept either: `export (default|async)? (function|const|enum|interface|type) <name>`
      // OR a re-export: `export { <name>, ... } from "..."`
      const directPattern = new RegExp(`export (default |async )?(function|const|enum|interface|type) ${exp}\\b`);
      const reExportPattern = new RegExp(`export\\s*\\{[^}]*\\b${exp}\\b[^}]*\\}\\s*from`);
      if (!directPattern.test(src) && !reExportPattern.test(src)) {
        violations.push({ file: relPath, issue: `Missing export: ${exp}` });
      }
    }
  }
  return violations;
}

// ── Runner ───────────────────────────────────────────────────────────────────

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

const allFiles = walk(ROOT_SRC);
const byRel = {};
for (const f of allFiles) byRel[relative(ROOT_SRC, f)] = f;

const allViolations = [
  ...checkExtensionFactories(allFiles),
  ...checkCriticsShape(allFiles),
  ...checkKeyTypeExports(byRel),
];

if (allViolations.length > 0) {
  console.log(`\n\u26a0\ufe0f  ${allViolations.length} API surface drift violation(s):\n`);
  for (const v of allViolations) {
    const loc = v.line ? `${v.file}:${v.line}` : v.file;
    console.log(`  ${loc}  [${v.func || v.critic || ""}] ${v.issue}`);
  }
  console.log(`\nFix these before they break consumers.\n`);
  process.exit(1);
}

console.log("\u2705 API surface drift check passed.");