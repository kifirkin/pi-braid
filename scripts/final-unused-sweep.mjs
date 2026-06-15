#!/usr/bin/env node
/**
 * Final pass: handle the 13 remaining unused-identifier cases.
 *
 * Each case is hand-mapped with exact line content. We do NOT do any
 * regex/parsing; we just apply exact replacements.
 */

import { readFileSync, writeFileSync } from "node:fs";

const fixes = [
  // ── src/lib/memory/index.ts:178 - remove _initialized field ──
  {
    file: "src/lib/memory/index.ts",
    oldText:
      "  private memoryStore: CognitiveMemoryStore;\n  private _initialized: boolean = false;",
    newText: "  private memoryStore: CognitiveMemoryStore;",
  },
  // ── src/lib/reasoning/mars-reflector.ts:67 - remove _state ──
  {
    file: "src/lib/reasoning/mars-reflector.ts",
    oldText:
      "export function buildPattern(ctx: ExtensionContext): SessionPattern {\n  const _state = getState(ctx);\n  // Get pattern from enforcement state if available",
    newText:
      "export function buildPattern(ctx: ExtensionContext): SessionPattern {\n  // Get pattern from enforcement state if available",
  },
  // ── src/lib/store/evidence-pool.ts:23-24 - remove classify+CRITICS ──
  {
    file: "src/lib/store/evidence-pool.ts",
    oldText:
      "import type { ExtensionContext } from \"@earendil-works/pi-coding-agent\";\nimport { getExtensionState } from \"../state/extension-state.js\";\nimport { classify } from \"../ai/text-classifier.js\";\nimport { CRITICS, STOP_WORDS } from \"../ai/critic-registry.js\";",
    newText:
      "import type { ExtensionContext } from \"@earendil-works/pi-coding-agent\";\nimport { getExtensionState } from \"../state/extension-state.js\";\nimport { STOP_WORDS } from \"../ai/critic-registry.js\";",
  },
  // ── src/lib/utils/sop-extractor.ts:222 - remove _categorySummary ──
  {
    file: "src/lib/utils/sop-extractor.ts",
    oldText:
      "  // ── Strategic SOP (high-level) ────────────────────────────────────────\n  // Describes WHAT to do at a strategy level\n  const _categorySummary = Object.entries(categories)\n    .sort((a, b) => b[1] - a[1])\n    .map(([cat, count]) => `${count}x ${cat}`)",
    newText:
      "  // ── Strategic SOP (high-level) ────────────────────────────────────────\n  // Describes WHAT to do at a strategy level",
  },
  // ── src/extensions/enforcement/validation.ts:32 - remove _uniqueInSeq ──
  {
    file: "src/extensions/enforcement/validation.ts",
    oldText:
      "  warnThreshold: number,\n): string | null {\n  const _uniqueInSeq = new Set(currentTools);\n  // Single-tool repetition: \"read,read\", \"bash,bash\"",
    newText:
      "  warnThreshold: number,\n): string | null {\n  // Single-tool repetition: \"read,read\", \"bash,bash\"",
  },
  // ── src/extensions/heartbeat/analytics/index.ts:19 - remove ExtensionContext from import ──
  {
    file: "src/extensions/heartbeat/analytics/index.ts",
    oldText:
      "import type {\n  ExtensionAPI,\n  ExtensionContext,\n} from \"@earendil-works/pi-coding-agent\";\nimport { safeSessionManager } from \"../../../lib/state/extension-state.js\";",
    newText:
      "import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";\nimport { safeSessionManager } from \"../../../lib/state/extension-state.js\";",
  },
];

let applied = 0;
let failed = [];

for (const fix of fixes) {
  try {
    let src = readFileSync(fix.file, "utf-8");
    if (!src.includes(fix.oldText)) {
      failed.push({ file: fix.file, reason: "oldText not found" });
      continue;
    }
    const newSrc = src.replace(fix.oldText, fix.newText);
    writeFileSync(fix.file, newSrc);
    applied++;
  } catch (e) {
    failed.push({ file: fix.file, reason: e.message });
  }
}

console.log(`Applied ${applied}/${fixes.length} fixes.`);
if (failed.length > 0) {
  console.log("Failed:");
  for (const f of failed) console.log(`  ${f.file}: ${f.reason}`);
}
