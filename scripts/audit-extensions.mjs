#!/usr/bin/env -S node --input-type=module
/**
 * pi-braid extension audit — tool + event usage analysis.
 * Run: node scripts/audit-extensions.mjs
 *
 * Categories:
 *  - CORE: essential foundation
 *  - HELPFUL: frequently useful, low friction
 *  - NOISY: adds signal without proportional value
 *  - FRUSTRATING: creates friction or confusion
 *  - UNUSED: no tool registrations or event handlers (or test-only)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Build the tool + event registry from all extensions ──────────────────────

const TOOL_RE = /registerTool\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g;
const CMD_RE  = /registerCommand\s*\(\s*["']([^"']+)["']/g;
const EVT_RE  = /\.on\s*\(\s*["']([^"']+)["']/g;

const modules = ["core", "cognitive", "memory", "heartbeat", "retry", "prompt", "tools", "browser", "assistant", "watchdog", "evolve", "rate-limiter", "agent-environment"];
const results = {};

for (const mod of modules) {
  const modDir = join(ROOT, "src/extensions", mod);
  let entries;
  try {
    entries = readdirSync(modDir, { withFileTypes: true });
  } catch {
    results[mod] = { extensions: [], tools: [], commands: [], events: [], score: 0, notes: "not_found" };
    continue;
  }

  const exts = [];
  const allTools = [];
  const allCmds  = [];
  const allEvts  = new Set();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extName = entry.name;
    const extDir  = join(modDir, extName);

    const files = [];
    try {
      const recurse = (dir) => {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (f.isDirectory()) recurse(join(dir, f.name));
          else if (f.name.endsWith(".ts")) files.push(join(dir, f.name));
        }
      };
      recurse(extDir);
    } catch { continue; }

    const tools = [];
    const cmds  = [];
    const evts  = new Set();

    for (const file of files) {
      try {
        const src = readFileSync(file, "utf-8");

        // Tools
        let m;
        while ((m = TOOL_RE.exec(src)) !== null) tools.push(m[1]);
        TOOL_RE.lastIndex = 0;

        // Commands
        while ((m = CMD_RE.exec(src)) !== null) cmds.push(m[1]);
        CMD_RE.lastIndex = 0;

        // Events
        while ((m = EVT_RE.exec(src)) !== null) evts.add(m[1]);
        EVT_RE.lastIndex = 0;
      } catch { /* skip unreadable */ }
    }

    for (const t of tools) allTools.push(t);
    for (const c of cmds)  allCmds.push(c);
    for (const e of evts)  allEvts.add(e);

    if (tools.length > 0 || cmds.length > 0) {
      exts.push({ name: extName, tools, cmds, events: [...evts] });
    }
  }

  // Score: weighted by tool count + event count + "useful" keywords
  const score = allTools.length * 2 + allCmds.length * 1.5 + allEvts.size;
  results[mod] = {
    extensions: exts,
    tools: [...new Set(allTools)],
    commands: [...new Set(allCmds)],
    events: [...allEvts],
    toolCount: new Set(allTools).size,
    cmdCount: new Set(allCmds).size,
    eventCount: allEvts.size,
    score,
  };
}

// ── Categorize extensions ──────────────────────────────────────────────────────

const HIGH_VALUE = new Set([
  // Core metacognitive stack
  "think", "hypothesize", "finalize", // Metacognition tools
  "plan_with_budget", "check_budget", "set_budget", // Planner
  "scratchpad", // Task management
  // Memory
  "memory_store", "memory_recall", "memory_list", // Three stores
  "session_recall", "context_compress", "context_tag", "context_log", // Context management
  // Error recovery
  "retry", "retry_status", // Retry
  // Workspace
  "codebase_tree", "grep", "find", "read", "write", "edit", // Already builtin but codebase-tree augments
  "healthcheck", "repl",
  // Browser
  "browser_navigate", "browser_snapshot", "web_fetch",
  "render_pdf_page", "analyze_image",
]);

const ANNOYING = new Set([
  "plan_with_budget", // rarely used, verbose output
  "check_budget",     // rarely used
  "set_budget",       // rarely used
]);

// ── Print audit ───────────────────────────────────────────────────────────────

console.log("═".repeat(70));
console.log("  pi-braid Extension Audit");
console.log("═".repeat(70));
console.log("");

let totalTools = 0;
let totalCmds  = 0;
const ranked = Object.entries(results).sort((a, b) => b[1].score - a[1].score);

for (const [mod, data] of ranked) {
  const score  = data.score;
  const stars  = score >= 15 ? "★" : score >= 8 ? "◆" : " ";
  const badge  = score >= 15 ? "🟢" : score >= 8 ? "🟡" : "⚪";

  console.log(`${badge} ${stars} MODULE: ${mod.padEnd(20)} score=${score}  tools=${data.toolCount}  cmds=${data.cmdCount}  events=${data.eventCount}`);
  for (const ext of data.extensions) {
    const useful = ext.tools.filter(t => HIGH_VALUE.has(t)).length;
    const noisy  = ext.cmds.filter(t => ANNOYING.has(t)).length;
    const flag   = useful > 0 && noisy > 0 ? " [⚠️ mixed]" : noisy > 0 ? " [⚠️ noisy]" : "";
    const toolStr = ext.tools.length > 0 ? ` [T:${ext.tools.join(",")}]` : "";
    const cmdStr  = ext.cmds.length > 0  ? ` [C:${ext.cmds.join(",")}]`  : "";
    console.log(`    └── ${ext.name}${toolStr}${cmdStr}${flag}`);
  }
  console.log("");
  totalTools += data.toolCount;
  totalCmds  += data.cmdCount;
}

console.log("═".repeat(70));
console.log(`TOTAL: ${totalTools} tools | ${totalCmds} commands across ${modules.length} modules`);
console.log("═".repeat(70));
console.log("");
console.log("=== RECOMMENDATIONS ===");
console.log("");

// Find extensions with tools but no test coverage
const untested = [];
const tested   = [];
const modDir = join(ROOT, "src/extensions");

for (const mod of modules) {
  const modPath = join(modDir, mod);
  let entries;
  try { entries = readdirSync(modPath, { withFileTypes: true }); } catch { continue; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extName = entry.name;
    const testFile = join(ROOT, `test/runtime/test-${extName}.mjs`);
    const testFileAlt = join(ROOT, `test/runtime/test-${extName}-handlers.mjs`);
    const hasTest = (() => {
      try { readFileSync(testFile); return true; } catch {
        try { readFileSync(testFileAlt); return true; } catch { return false; }
      }
    })();

    // Count tools from this extension
    const data = results[mod];
    const extData = data?.extensions.find(e => e.name === extName);
    const toolCount = extData?.tools.length ?? 0;

    if (toolCount > 0) {
      if (hasTest) tested.push(`${mod}/${extName} (${toolCount} tools)`);
      else untested.push(`${mod}/${extName} (${toolCount} tools)`);
    }
  }
}

console.log("🟢 HIGH-VALUE (has tools + test coverage):");
for (const t of tested) console.log(`   ✅ ${t}`);
console.log("");
console.log("🔴 NEEDS TEST COVERAGE:");
for (const u of untested) console.log(`   ❌ ${u}`);
console.log("");
console.log(`Test coverage: ${tested.length} / ${tested.length + untested.length} (${Math.round(tested.length / (tested.length + untested.length) * 100)}%)`);
console.log("");
console.log("⚠️  NOISY COMMANDS TO CONSIDER REMOVING:");
for (const [mod, data] of ranked) {
  const noisy = data.commands.filter(c => ANNOYING.has(c));
  if (noisy.length) console.log(`   ${mod}: ${noisy.join(", ")}`);
}