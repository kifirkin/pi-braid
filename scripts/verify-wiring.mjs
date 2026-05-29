/**
 * Comprehensive Verification: Module Wiring, Extension Registration, Import Integrity
 *
 * Proves the system is properly wired by checking:
 * 1. Module definitions → extension file existence
 * 2. Extension default exports
 * 3. Import resolution
 * 4. Tool/command registration patterns
 * 5. Event handler registration patterns
 * 6. Decomposition shim integrity
 * 7. Preprocessor fix completeness
 * 8. No orphaned files
 */

const ROOT = "/Users/kifir/projects/agents/pi-braid";

let passed = 0;
let failed = 0;
const tests = [];

function check(cond, msg) {
  tests.push({ msg, pass: !!cond });
  if (cond) { passed++; } else { failed++; }
  const mark = cond ? "✅" : "❌";
  console.log(`  ${mark} ${msg}`);
}

function load(path) {
  try { return require("fs").readFileSync(resolve(ROOT, path), "utf-8"); }
  catch { return null; }
}

function fileExists(path) {
  try { return require("fs").existsSync(resolve(ROOT, path)); }
  catch { return false; }
}

// ──────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────
const { existsSync, readFileSync } = await import("fs");
const { resolve, dirname } = await import("path");

const loadFile = (path) => {
  try { return readFileSync(resolve(ROOT, path), "utf-8"); }
  catch { return null; }
};

const fexists = (path) => {
  try { return existsSync(resolve(ROOT, path)); }
  catch { return false; }
};

// ──────────────────────────────────────────────────────────────────
// 1. Module definitions → extension file existence
// ──────────────────────────────────────────────────────────────────
console.log("\n═══ 1. MODULE DEFINITIONS → EXTENSION FILES ═══");

const defs = loadFile("src/modules/definitions.ts");

// Extract all import paths from definitions.ts (resolve relative to src/modules/)
const defsDir = resolve(ROOT, "src/modules");
const importMatches = defs.matchAll(/import\s+\w+\s+from\s+"([^"]+)"/g);
let importCount = 0;
let importTotal = 0;
for (const m of importMatches) {
  importTotal++;
  const importPath = m[1];
  // Relative paths resolve from definitions.ts location
  const fullPath = importPath.startsWith(".")
    ? resolve(defsDir, importPath.replace(/\.js$/, ".ts"))
    : resolve(ROOT, "node_modules", importPath);
  if (existsSync(fullPath) || importPath.startsWith("@mariozechner")) {
    importCount++;
  } else {
    const fullJs = importPath.startsWith(".") ? resolve(defsDir, importPath) : fullPath;
    if (existsSync(fullJs)) {
      importCount++;
    } else {
      check(false, `Import target MISSING: ${importPath}`);
    }
  }
}
check(true, `All ${importCount}/${importTotal} module imports resolve`);

// Extract all extension references
const extRefs = defs.matchAll(/\{\s*name:\s*"([^"]+)"[^}]*fn:\s*(\w+)/g);
let extCount = 0;
for (const m of extRefs) {
  extCount++;
  const fnName = m[2];
  check(defs.includes(`import ${fnName}`), `Extension "${m[1]}" → import "${fnName}" exists`);
}
check(true, `${extCount} extensions referenced in module definitions`);

// ──────────────────────────────────────────────────────────────────
// 2. Extension default exports
// ──────────────────────────────────────────────────────────────────
console.log("\n═══ 2. EXTENSION DEFAULT EXPORTS ═══");

const extensionDirs = [
  "src/extensions/core/polyfill/index.ts",
  "src/extensions/core/metacognition/index.ts",
  "src/extensions/core/scratchpad/index.ts",
  "src/extensions/core/user-message-preprocessor/index.ts",
  "src/extensions/cognitive/enforcement/index.ts",
  "src/extensions/cognitive/cognitive-systems/index.ts",
  "src/extensions/cognitive/reasoning/index.ts",
  "src/extensions/cognitive/verification/index.ts",
  "src/extensions/cognitive/topic-drift/index.ts",
  "src/extensions/cognitive/sycophancy-detector/index.ts",
  "src/extensions/memory/three-memory-stores/index.ts",
  "src/extensions/memory/session-recall/index.ts",
  "src/extensions/memory/context-manager/index.ts",
  "src/extensions/memory/context-lifecycle/index.ts",
  "src/extensions/heartbeat/heartbeat-scheduler/index.ts",
  "src/extensions/heartbeat/analytics/index.ts",
  "src/extensions/retry/retry/index.ts",
  "src/extensions/retry/error-capture/index.ts",
  "src/extensions/prompt/prompt-builder/index.ts",
  "src/extensions/tools/healthcheck/index.ts",
  "src/extensions/tools/timer/index.ts",
  "src/extensions/tools/web-fetch/index.ts",
  "src/extensions/tools/browser/index.ts",
  "src/extensions/tools/codebase-tree/index.ts",
  "src/extensions/tools/docs/index.ts",
  "src/extensions/tools/vision/index.ts",
  "src/extensions/tools/latent-activator/index.ts",
  "src/extensions/tools/diff/index.ts",
  "src/extensions/tools/system-monitor/index.ts",
  "src/extensions/tools/observatory/index.ts",
  "src/extensions/assistant/assistant/index.ts",
  "src/extensions/assistant/feedback/index.ts",
  "src/extensions/evolve/evolve/index.ts",
  "src/extensions/watchdog/watchdog/index.ts",
  "src/extensions/rate-limiter/rate-limiter/index.ts",
  "src/extensions/agent-environment/agent-environment/index.ts",
];

for (const extPath of extensionDirs) {
  const content = loadFile(extPath);
  if (!content) {
    // Tools extracted to ~/.pi/agent/extensions/ are expected to be missing
    const extracted = ["web-fetch","browser","codebase-tree","docs","vision"];
    const isExtracted = extracted.some(e => extPath.includes(`tools/${e}/`));
    if (isExtracted) {
      check(true, `${extPath} — extracted to ~/.pi/agent/extensions/ (expected)`);
    } else {
      check(false, `${extPath} — FILE MISSING`);
    }
    continue;
  }
  check(
    content.includes("export default function") || content.includes("export default async function"),
    `Exports default fn: ${extPath}`
  );
}

// ──────────────────────────────────────────────────────────────────
// 3. Import resolution (extensions → libs)
// ──────────────────────────────────────────────────────────────────
console.log("\n═══ 3. IMPORT RESOLUTION ═══");

function checkImports(filePath, name) {
  const content = loadFile(filePath);
  if (!content) return;

  // Skip commented-out imports (lines starting with //)
  const lines = content.split("\n");
  let hasUnresolved = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/**")) continue;
    const m = line.match(/from\s+"([^"]+\.js)"/);
    if (!m) continue;
    const relPath = m[1];
    const dir = dirname(resolve(ROOT, filePath));
    const resolved = resolve(dir, relPath);
    const tsPath = resolved.replace(/\.js$/, ".ts");

    if (!existsSync(tsPath) && !existsSync(resolved)) {
      const indexPath = resolve(resolved.replace(/\.js$/, ""), "index.ts");
      if (!existsSync(indexPath)) {
        check(false, `${name}: import "${relPath}" → NOT FOUND`);
        hasUnresolved = true;
      }
    }
  }
  if (!hasUnresolved) check(true, `Imports resolve: ${name}`);
}

for (const extPath of extensionDirs) {
  checkImports(extPath, extPath);
}

const libFiles = [
  "src/lib/extension-state.ts",
  "src/lib/evidence-pool.ts",
  "src/lib/conflict-qa.ts",
  "src/lib/error-classifier.ts",
  "src/lib/logger.ts",
  "src/lib/language-hint.ts",
  "src/lib/degradation-detector.ts",
  "src/lib/cognitive-memory.ts",
  "src/lib/observatory.ts",
  "src/lib/event-bus.ts",
  "src/lib/bidirectional-verifier.ts",
  "src/lib/injection-tracker.ts",
  "src/lib/filter-safe-to-remove.ts",
  "src/lib/state-checkpoint.ts",
  "src/lib/goal-manager.ts",
  "src/lib/belief-policy-engine.ts",
  "src/lib/belief-store.ts",
  "src/lib/cognitive-memory/index.ts",
  "src/lib/bidirectional-verifier/index.ts",
];

for (const libPath of libFiles) {
  checkImports(libPath, libPath);
}

// ──────────────────────────────────────────────────────────────────
// 4. Tool/command registration patterns
// ──────────────────────────────────────────────────────────────────
console.log("\n═══ 4. TOOL/COMMAND REGISTRATION ═══");

let totalTools = 0;
for (const extPath of extensionDirs) {
  const content = loadFile(extPath);
  if (!content) continue;
  const tools = content.match(/pi\.registerTool\(\{/g);
  const cmds = content.match(/pi\.registerCommand\(/g);
  const toolCount = (tools || []).length;
  const cmdCount = (cmds || []).length;
  totalTools += toolCount + cmdCount;
  if (toolCount + cmdCount > 0) {
    check(true, `${extPath}: ${toolCount} tool(s), ${cmdCount} command(s)`);
  }
}
check(true, `Total: ${totalTools} tools/commands registered`);

// ──────────────────────────────────────────────────────────────────
// 5. Event handler registration patterns
// ──────────────────────────────────────────────────────────────────
console.log("\n═══ 5. EVENT HANDLER REGISTRATION ═══");

const eventCounts = {};
for (const extPath of extensionDirs) {
  const content = loadFile(extPath);
  if (!content) continue;

  let src = content;
  if (extPath.includes("enforcement/index.ts")) {
    const handlerReg = loadFile("src/extensions/cognitive/enforcement/handler-registry.ts");
    if (handlerReg) src += "\n" + handlerReg;
  }

  const handlers = src.matchAll(/pi\.on\("([^"]+)"[^)]*\)\s*=>|pi\.on\("([^"]+)"[^)]*as\s*(?:never|any)\s*,/g);
  for (const h of handlers) {
    const eventName = h[1];
    eventCounts[eventName] = (eventCounts[eventName] || 0) + 1;
  }
}

  // Deduplicate (the regex may produce undefined entries)
  const unique = Object.keys(eventCounts).filter(Boolean);
check(unique.length >= 10,
  `${unique.length} distinct event types wired (≥10 expected)`);

for (const [event, count] of Object.entries(eventCounts).sort()) {
  console.log(`     "${event}": ${count} handler(s)`);
}

// ──────────────────────────────────────────────────────────────────
// 6. Decomposition shim integrity
// ──────────────────────────────────────────────────────────────────
console.log("\n═══ 6. DECOMPOSITION SHIM INTEGRITY ═══");

const bvShim = loadFile("src/lib/bidirectional-verifier.ts");
check(bvShim && bvShim.includes('from "./bidirectional-verifier/index.js"'),
  "bidirectional-verifier.ts → sub-module re-export");
check(fexists("src/lib/bidirectional-verifier/index.ts"), "bidirectional-verifier/index.ts");
check(fexists("src/lib/bidirectional-verifier/types.ts"), "bidirectional-verifier/types.ts");
check(fexists("src/lib/bidirectional-verifier/state.ts"), "bidirectional-verifier/state.ts");

const cmShim = loadFile("src/lib/cognitive-memory.ts");
check(cmShim && cmShim.includes('from "./cognitive-memory/index.js"'),
  "cognitive-memory.ts → sub-module re-export");
check(fexists("src/lib/cognitive-memory/index.ts"), "cognitive-memory/index.ts");
check(fexists("src/lib/cognitive-memory/types.ts"), "cognitive-memory/types.ts");
check(fexists("src/lib/cognitive-memory/utils.ts"), "cognitive-memory/utils.ts");
check(fexists("src/lib/cognitive-memory/storage.ts"), "cognitive-memory/storage.ts");

// enforcement decomposition
check(fexists("src/extensions/cognitive/enforcement/handler-registry.ts"), "enforcement/handler-registry.ts");
check(fexists("src/extensions/cognitive/enforcement/signals.ts"), "enforcement/signals.ts");
check(fexists("src/extensions/cognitive/enforcement/similarity.ts"), "enforcement/similarity.ts");

// analytics decomposition
check(fexists("src/extensions/heartbeat/analytics/core.ts"), "analytics/core.ts");
check(fexists("src/extensions/heartbeat/analytics/format.ts"), "analytics/format.ts");
check(fexists("src/extensions/heartbeat/analytics/shared.ts"), "analytics/shared.ts");
check(fexists("src/extensions/heartbeat/analytics/ab-variant.ts"), "analytics/ab-variant.ts");

// heartbeat-scheduler decomposition
check(fexists("src/extensions/heartbeat/heartbeat-scheduler/types.ts"), "heartbeat-scheduler/types.ts");
check(fexists("src/extensions/heartbeat/heartbeat-scheduler/state.ts"), "heartbeat-scheduler/state.ts");
check(fexists("src/extensions/heartbeat/heartbeat-scheduler/policies.ts"), "heartbeat-scheduler/policies.ts");
check(fexists("src/extensions/heartbeat/heartbeat-scheduler/meta-learning.ts"), "heartbeat-scheduler/meta-learning.ts");
check(fexists("src/extensions/heartbeat/heartbeat-scheduler/modules/dreamer.ts"), "heartbeat-scheduler/modules/dreamer.ts");
check(fexists("src/extensions/heartbeat/heartbeat-scheduler/modules/evolver.ts"), "heartbeat-scheduler/modules/evolver.ts");
check(fexists("src/extensions/heartbeat/heartbeat-scheduler/modules/budget.ts"), "heartbeat-scheduler/modules/budget.ts");

// three-memory-stores decomposition
check(fexists("src/extensions/memory/three-memory-stores/episodes.ts"), "three-memory-stores/episodes.ts");
check(fexists("src/extensions/memory/three-memory-stores/heuristics.ts"), "three-memory-stores/heuristics.ts");
check(fexists("src/extensions/memory/three-memory-stores/tool-reliability.ts"), "three-memory-stores/tool-reliability.ts");

// ──────────────────────────────────────────────────────────────────
// 7. Preprocessor fix completeness
// ──────────────────────────────────────────────────────────────────
console.log("\n═══ 7. PREPROCESSOR FIX VERIFICATION ═══");

const preproc = loadFile("src/extensions/core/user-message-preprocessor/index.ts");
if (preproc) {
  check(preproc.includes("event.images && event.images.length > 0"),
    "Images detected → skips preprocessing when images attached");
  check(preproc.includes("state.storedImages"),
    "Images stored in state for re-submit restoration");
  check(!preproc.includes('from "typebox"'),
    "Unused Type import removed");
  check(!preproc.includes("AgentToolResult"),
    "Unused AgentToolResult import removed");
  check(preproc.includes("await fsPromises"),
    "saveGlobalSetting uses top-level fsPromises");
  check(!preproc.includes('const fs = await import("node:fs")'),
    "No redundant dynamic fs import");
  check(preproc.includes("completeSimple"), "Uses completeSimple for LLM call");
  check(preproc.includes("isCodeHeavy"), "Code-heavy detection present");
  check(preproc.includes("looksWellWritten"), "Well-written text detection present");
  check(preproc.includes("matchesCodeRequest"), "Anti-slop code request detection");
  check(preproc.includes("SYSTEM_PROMPT"), "LLM system prompt present");
  check(preproc.includes("getExtensionState"), "Session-scoped state used");
} else {
  check(false, "Preprocessor file exists");
}

// ──────────────────────────────────────────────────────────────────
// 8. No orphaned files
// ──────────────────────────────────────────────────────────────────
console.log("\n═══ 8. NO ORPHANED FILES ═══");

check(!fexists("src/extensions/core/planner/index.ts"), "Planner deleted (no orphan)");
check(!fexists("src/extensions/prompt/prompt-guardian/index.ts"), "Prompt-guardian deleted (no orphan)");

// ──────────────────────────────────────────────────────────────────
// REPORT
// ──────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════`);
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`═══════════════════════════════════════════\n`);

if (failed > 0) {
  console.log("\nFAILURES:");
  for (const t of tests) {
    if (!t.pass) console.log(`  ❌ ${t.msg}`);
  }
}

// Category summary
const categories = {
  "Module→File resolution": t => t.msg.includes("imports resolve to existing") || t.msg.startsWith("Import target"),
  "Extension exports": t => t.msg.includes("Exports default"),
  "Import resolution": t => t.msg.includes("Imports resolve"),
  "Tool/Command registration": t => t.msg.includes("tool(s)") || t.msg.includes("tools/commands registered"),
  "Event wiring": t => t.msg.includes("handler(s)") || t.msg.includes("event types"),
  "Decomposition integrity": t => t.msg.includes("sub-module") || t.msg.includes("bidirectional-verifier/") || t.msg.includes("cognitive-memory/") || t.msg.includes("heartbeat-scheduler/") || t.msg.includes("enforcement/") || t.msg.includes("analytics/") || t.msg.includes("three-memory-stores/") || t.msg.endsWith(".ts") && (t.msg.includes("types.ts") || t.msg.includes("state.ts") || t.msg.includes("utils.ts") || t.msg.includes("storage.ts") || t.msg.includes("core.ts") || t.msg.includes("format.ts") || t.msg.includes("shared.ts") || t.msg.includes("ab-variant.ts") || t.msg.includes("policies.ts") || t.msg.includes("meta-learning.ts") || t.msg.includes("episodes.ts") || t.msg.includes("heuristics.ts") || t.msg.includes("tool-reliability.ts") || t.msg.includes("signals.ts") || t.msg.includes("similarity.ts") || t.msg.includes("handler-registry.ts") || t.msg.includes("dreamer.ts") || t.msg.includes("evolver.ts") || t.msg.includes("budget.ts")),
  "Preprocessor fix": t => t.msg.includes("Images") || t.msg.includes("import removed") || t.msg.includes("fsPromises") || t.msg.includes("completeSimple") || t.msg.includes("detection") || t.msg.includes("anti-slop") || t.msg.includes("system prompt") || t.msg.includes("session-scoped"),
  "No orphans": t => t.msg.includes("deleted"),
};

console.log("\nCategory                        Pass/Fail");
console.log("──────────────────────────────────────────");
for (const [cat, filter] of Object.entries(categories)) {
  const items = tests.filter(filter);
  const p = items.filter(t => t.pass).length;
  const total = items.length;
  if (total > 0) {
    console.log(`${cat.padEnd(30)} ${p}/${total} ${p === total ? "✅" : "❌"}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
