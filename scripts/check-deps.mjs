#!/usr/bin/env node
/**
 * Dependency Consistency + Layer Boundary Checker
 *
 * Scans all import/reference paths across src/ and test/,
 * validates targets exist (with TypeScript-aware resolution),
 * and enforces layer boundaries (extensions cannot depend on
 * each other, lib/ cannot depend on extensions/, etc.).
 *
 * Usage: node scripts/check-deps.mjs
 * Exit code: 0 = clean, 1 = issues found
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// ── Layer Configuration ────────────────────────────────────────────────────
//
// Layer model:
//   lib/        — Foundation. Depends only on itself and npm packages.
//   extensions/ — Pi extensions. Each subdirectory is an isolated module.
//                 Can depend on lib/ and npm, but NOT on other extensions.
//   loader/     — Runtime extension loader and subagent API. Can depend
//                 on lib/, extensions/ (to load them), and npm.
//   types/      — Type declarations. Depends only on npm.
//   root (src/) — Entry point. Can import anything.
//
// manifest.ts is exempted — it's the extension registration orchestrator
// that legitimately references all extension subdirectories.

const LAYER_RULES = {
  lib:     { parent: null, allowExtensions: false,   allowOtherLayers: false, allowCrossExtension: false },
  loader:  { parent: null, allowExtensions: true,    allowOtherLayers: false, allowCrossExtension: false },
};

// Known architecturally-validated cross-extension dependencies.
// These are established integration points that would cost more to
// refactor than the coupling is worth. Listed here so they're
// documented and auditable.
const ALLOWED_BOUNDARY_OVERRIDES = [
  // heartbeat ↔ memory: Heartbeat scheduler coordinates memory health checks
  "ext/heartbeat → ext/memory",
  "ext/memory → ext/heartbeat",
  // health-maintenance ↔ heartbeat: Health maintenance reports to analytics
  "ext/health-maintenance → ext/heartbeat",
  // sycophancy-detector → enforcement: Sycophancy signals enforcement whisper
  "ext/cognitive → ext/enforcement",
  // analytics → reasoning: Analytics surfaces reasoning stability in get_session_metrics
  "ext/heartbeat → ext/cognitive",
];

// ── File collection ────────────────────────────────────────────────────────

function collectFiles(dir, filter) {
  const out = [];
  try {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (n === "node_modules" || n.startsWith(".")) continue;
      if (statSync(f).isDirectory()) out.push(...collectFiles(f, filter));
      else if (!filter || filter(n)) out.push(f);
    }
  } catch { /* skip */ }
  return out;
}

const TS_FILES = collectFiles(join(ROOT, "src"), (n) => /\.ts$/.test(n));
const TEST_FILES = collectFiles(join(ROOT, "test"), (n) => /\.(mjs|js)$/.test(n));

// ── Layer resolution ────────────────────────────────────────────────────────

/**
 * Determine the layer group for a source file path.
 * Returns { layer: string, group: string|null } where `group` is the
 * extension/contrib subdirectory name (e.g., "enforcement", "cognitive").
 * Layers: "lib", "ext", "contrib", "modules", "types", "root"
 */
function getFileLayer(absPath) {
  const rel = relative(ROOT, absPath);
  if (rel.startsWith("src/lib/"))        return { layer: "lib",     group: null };
  if (rel.startsWith("src/loader/"))     return { layer: "loader",  group: null };
  if (rel.startsWith("src/types/"))      return { layer: "types",   group: null };

  const extMatch = rel.match(/^src\/extensions\/([^/]+)/);
  if (extMatch) return { layer: "ext", group: extMatch[1] };

  if (rel.startsWith("src/"))            return { layer: "root",    group: null };
  return { layer: "external", group: null };
}

/**
 * Check whether importing from `source` to `target` is allowed by layer rules.
 */
function isLayerAllowed(sourceLayer, sourceGroup, targetLayer, targetGroup) {
  // Same layer (and same group for ext) — always allowed
  if (sourceLayer === targetLayer) {
    if (sourceLayer === "ext" && sourceGroup !== targetGroup) {
      // Cross-extension import — not allowed
      return false;
    }
    return true;
  }

  // Neither layer has specific rules — allow
  const rule = LAYER_RULES[sourceLayer];
  if (!rule) return true;

  // Target is an extension
  if (targetLayer === "ext") {
    return rule.allowExtensions;
  }

  // Target is a concrete non-extension layer
  if (targetLayer === "lib")   return true;
  if (targetLayer === "root")  return true;
  if (targetLayer === "loader") return rule.allowOtherLayers;
  if (targetLayer === "types")   return rule.allowOtherLayers;

  return false;
}

// ── TypeScript-aware import resolution ─────────────────────────────────────

function resolveImport(sourceFile, importPath) {
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;

  if (importPath.startsWith("/")) {
    const abs = join(ROOT, importPath.slice(1));
    return tryResolve(abs);
  }

  const base = dirname(sourceFile);
  let abs = resolve(base, importPath);

  // TypeScript resolves `.js` imports to `.ts` in source — strip `.js` first
  if (abs.endsWith(".js")) {
    try {
      if (statSync(abs).isFile()) return abs;
    } catch { /* not a file, try .ts */ }
    const tsPath = abs.slice(0, -3) + ".ts";
    try { if (statSync(tsPath).isFile()) return tsPath; } catch { /* */ }
    // Try index.ts for directory imports ending in /index.js
    const dir = abs.slice(0, -9); // strip /index.js
    const idxTs = dir + "/index.ts";
    try { if (statSync(idxTs).isFile()) return idxTs; } catch { /* */ }
  }

  const mapping = [".ts", ".mts", ".cts", ".mjs", ".js", ""];
  const indexMapping = ["/index.ts", "/index.mjs", "/index.js", "/index.mts", "/index.cts", ""];

  for (const ext of mapping) {
    try { if (statSync(abs + ext).isFile()) return abs + ext; } catch { /* try next */ }
  }
  for (const idx of indexMapping) {
    try { if (statSync(abs + idx).isFile()) return abs + idx; } catch { /* try next */ }
  }

  return null;
}

function tryResolve(abs) {
  if (abs.endsWith(".js")) {
    try { if (statSync(abs).isFile()) return abs; } catch { /* try .ts */ }
    const tsPath = abs.slice(0, -3) + ".ts";
    try { if (statSync(tsPath).isFile()) return tsPath; } catch { /* */ }
    const dir = abs.slice(0, -9); // strip /index.js
    const idxTs = dir + "/index.ts";
    try { if (statSync(idxTs).isFile()) return idxTs; } catch { /* */ }
  }
  const exts = [".ts", ".mjs", ".js", ".mts", ".cts"];
  for (const ext of exts) {
    try { if (statSync(abs + ext).isFile()) return abs + ext; } catch { /* */ }
  }
  try { if (statSync(abs).isFile()) return abs; } catch { /* */ }
  return null;
}

// ── Extract import paths ───────────────────────────────────────────────────

// Skip imports found in JSDoc/block comments and single-line comments
const importPattern = /(?:from\s+["']([^"']+)["']|require\(["']([^"']+)["'])/g;
const lineCommentPattern = /^\s*\/\//;

const issuesMissing = [];
const issuesBoundary = [];
const issuesStale = [];

for (const f of TS_FILES) {
  const relPath = relative(ROOT, f);
  const content = readFileSync(f, "utf-8");
  const sourceLayer = getFileLayer(f);

  const lines = content.split("\n");
  const matches = [...content.matchAll(importPattern)];
  for (const m of matches) {
    const raw = m[1] || m[2];
    if (!raw) continue;

    // Skip imports inside comments (JSDoc examples, commented-out code)
    const lineIndex = content.slice(0, m.index).split("\n").length - 1;
    const line = lines[lineIndex];
    if (lineCommentPattern.test(line) || /^\s*\*/.test(line)) continue;

    // Non-relative imports (npm packages) — always allowed
    if (!raw.startsWith(".") && !raw.startsWith("/")) continue;

    // Exempt manifest.ts from boundary checks — it's the extension registry
    const isManifest = relPath === "src/extensions/manifest.ts";

    const resolved = resolveImport(f, raw);
    if (!resolved) {
      issuesMissing.push({ type: "missing", file: relPath, import: raw });
      continue;
    }

    // Layer boundary check (skip for test files, external deps, and manifest.ts)
    if (isManifest) continue;
    const targetLayer = getFileLayer(resolved);
    if (targetLayer.layer !== "external" && sourceLayer.layer !== "external") {
      if (!isLayerAllowed(sourceLayer.layer, sourceLayer.group, targetLayer.layer, targetLayer.group)) {
        const srcLabel = sourceLayer.group
          ? `ext/${sourceLayer.group}`
          : sourceLayer.layer;
        const tgtLabel = targetLayer.group
          ? `ext/${targetLayer.group}`
          : targetLayer.layer;
        const pairKey = `${sourceLayer.layer === "ext" ? `ext/${sourceLayer.group}` : sourceLayer.layer} → ${targetLayer.layer === "ext" ? `ext/${targetLayer.group}` : targetLayer.layer}`;
        // Skip known architecturally-validated overrides
        if (ALLOWED_BOUNDARY_OVERRIDES.includes(pairKey)) continue;
        issuesBoundary.push({
          type: "boundary",
          file: relPath,
          import: raw,
          resolved: relative(ROOT, resolved),
          from: srcLabel,
          to: tgtLabel,
        });
      }
    }
  }
}

// ── Stale test references ──────────────────────────────────────────────────

for (const f of TEST_FILES) {
  const rel = relative(ROOT, f);
  const content = readFileSync(f, "utf-8");

  // Skip lines that look like test assertions — they contain test data strings,
  // not deliberate source file references. Only flag lines that use
  // readFileSync or import-based patterns.
  const lines = content.split("\n");
  const fileRefs = [...content.matchAll(/["'`](src\/[^"'`]+)["'`]/g)];
  for (const m of fileRefs) {
    // Get the line for context
    const lineIndex = content.slice(0, m.index).split("\n").length - 1;
    const line = lines[lineIndex];

    // Skip if line is inside a test assertion (test data, not real refs)
    if (/\b(assert|deepEqual|test\(|it\()/.test(line) && !/readFileSync/.test(line)) continue;

    const target = join(ROOT, m[1]);
    try {
      statSync(target);
    } catch {
      try { statSync(target + ".ts"); } catch {
        try { statSync(target + ".mjs"); } catch {
          const distMatch = m[1].match(/^dist\/(.+)\.js$/);
          if (distMatch) {
            const src = join(ROOT, "src", distMatch[1]);
            const srcTs = src + ".ts";
            const srcIndex = join(src, "index.ts");
            try { statSync(srcTs); continue; } catch { /* */ }
            try { statSync(srcIndex); continue; } catch { /* */ }
          }
          issuesStale.push({ type: "stale_test_ref", file: rel, import: m[1] });
        }
      }
    }
  }
}

// ── Extension entry point validation ───────────────────────────────────────────

/**
 * Verify extension directories that contain .ts files directly (not in subdirs)
 * have an index.ts entry point. Namespace/parent directories like cognitive/,
 * core/, heartbeat/ only contain sub-extensions and don't need their own.
 */
function hasTsFilesDirect(dir) {
  try {
    for (const n of readdirSync(dir)) {
      if (n.startsWith(".")) continue;
      const f = join(dir, n);
      if (statSync(f).isFile() && /\.ts$/.test(n)) return true;
    }
  } catch { /* */ }
  return false;
}

const extBase = join(ROOT, "src", "extensions");
for (const name of readdirSync(extBase)) {
  const dir = join(extBase, name);
  if (!statSync(dir).isDirectory()) continue;
  if (!hasTsFilesDirect(dir)) continue;
  let hasEntry = false;
  for (const entry of ["index.ts", "index.mts", "index.mjs"]) {
    try { if (statSync(join(dir, entry)).isFile()) hasEntry = true; } catch { /* */ }
  }
  if (!hasEntry) {
    issuesStale.push({ type: "missing_extension_entry", file: `src/extensions/${name}`, import: "index.ts" });
  }
}

// ── API surface drift: tool registration consistency ───────────────────────────

/**
 * Validate that tool registrations across all extensions/contrib are consistent.
 * Checks for:
 *   1. Duplicate tool names (two extensions registering the same tool)
 *   2. Tools with empty/minimal descriptions
 *   3. Tools with no parameters schema
 */
const toolDups = [];
const toolNames = new Map();

for (const f of TS_FILES) {
  const rel = relative(ROOT, f);
  const content = readFileSync(f, "utf-8");

  // Find each pi.registerTool({...}) block using brace counting
  let idx = 0;
  while (idx < content.length) {
    const regStart = content.indexOf("pi.registerTool({", idx);
    if (regStart === -1) break;

    // Find closing brace accounting for nesting
    let depth = 1;
    let i = regStart + "pi.registerTool({".length;
    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      i++;
    }
    const block = content.slice(regStart, i);
    idx = i;

    // Extract name
    const nameMatch = block.match(/name:\s*["']([^"']+)["']/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    // Check for duplicate
    if (toolNames.has(name)) {
      const existing = toolNames.get(name);
      toolDups.push({ name, file1: existing.file, file2: rel });
      continue;
    }

    // Extract description
    const descMatch = block.match(/description:\s*["']([^"']*)["']/);
    const hasGoodDesc = descMatch ? descMatch[1].length > 10 : false;

    // Check if parameters property exists
    const hasParams = /\bparameters\b/.test(block);

    toolNames.set(name, { file: rel, hasGoodDesc, hasParams });
  }
}

// Report issues
for (const dup of toolDups) {
  issuesBoundary.push({
    type: "duplicate_tool_name",
    file: dup.file1,
    import: `"${dup.name}" also registered in ${dup.file2}`,
    resolved: dup.file2,
    from: dup.file1,
    to: dup.file2,
  });
}

// Null-op just to track counts; no gate failures — this is advisory
// but can be escalated to warnings later.
// Tracked in `issuesStale` so they appear in output.
for (const [name, info] of toolNames) {
  if (!info.hasGoodDesc) {
    issuesStale.push({ type: "short_tool_description", file: info.file, import: `"${name}" description` });
  }
  if (!info.hasParams && !info.file.includes("contrib/")) {
    issuesStale.push({ type: "missing_tool_params", file: info.file, import: `"${name}" no parameters` });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

const allIssues = [...issuesMissing, ...issuesBoundary, ...issuesStale];

if (allIssues.length === 0) {
  console.log(`✅ Dependency check clean — ${TS_FILES.length} source files, ${TEST_FILES.length} test files`);
  process.exit(0);
}

let exitCode = 0;

if (issuesMissing.length > 0) {
  exitCode = 1;
  console.error(`❌ Missing imports (${issuesMissing.length}):\n`);
  for (const issue of issuesMissing) {
    console.error(`  MISSING: ${issue.file} → "${issue.import}"`);
  }
  console.error();
}

if (issuesBoundary.length > 0) {
  exitCode = 1;
  console.error(`❌ Layer boundary violations (${issuesBoundary.length}):\n`);
  for (const issue of issuesBoundary) {
    console.error(`  BOUNDARY: ${issue.file}`);
    console.error(`            imports "${issue.import}" → ${issue.resolved}`);
    console.error(`            (${issue.from} → ${issue.to})`);
  }
  console.error();
}

if (issuesStale.length > 0) {
  exitCode = 1;
  console.error(`❌ Stale test references (${issuesStale.length}):\n`);
  for (const issue of issuesStale) {
    console.error(`  STALE:   ${issue.file} → "${issue.import}"`);
  }
  console.error();
}

console.error(`Run: node scripts/check-deps.mjs`);
process.exit(exitCode);