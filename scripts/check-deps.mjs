/**
 * Dependency Consistency Checker
 *
 * Scans all import/reference paths across src/ and test/,
 * validates targets exist with TypeScript-aware resolution.
 *
 * Usage: node scripts/check-deps.mjs
 * Exit code: 0 = clean, 1 = issues found
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

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

// ── TypeScript-aware import resolution ─────────────────────────────────────

function resolveImport(sourceFile, importPath) {
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;

  if (importPath.startsWith("/")) {
    const abs = join(ROOT, importPath.slice(1));
    return tryResolve(abs);
  }

  const base = dirname(sourceFile);
  const abs = resolve(base, importPath);

  // TypeScript resolves `.js` imports to `.ts` in source
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
  const exts = [".ts", ".mjs", ".js", ".mts", ".cts"];
  for (const ext of exts) {
    try { if (statSync(abs + ext).isFile()) return abs + ext; } catch { /* */ }
  }
  try { if (statSync(abs).isFile()) return abs; } catch { /* */ }
  return null;
}

// ── Extract import paths ───────────────────────────────────────────────────

const importPattern = /(?:from\s+["']([^"']+)["']|require\(["']([^"']+)["'])/g;

const issues = [];

for (const f of TS_FILES) {
  const relPath = relative(ROOT, f);
  const content = readFileSync(f, "utf-8");
  const matches = [...content.matchAll(importPattern)];
  for (const m of matches) {
    const raw = m[1] || m[2];
    if (!raw || !raw.startsWith(".")) continue;
    const resolved = resolveImport(f, raw);
    if (!resolved) {
      issues.push({ type: "missing", file: relPath, import: raw });
    }
  }
}

// ── Stale test references ──────────────────────────────────────────────────
// Tests often use readFileSync/readdirSync with hardcoded paths to source files

for (const f of TEST_FILES) {
  const rel = relative(ROOT, f);
  const content = readFileSync(f, "utf-8");

  // Match hardcoded src/... paths in strings
  const fileRefs = [...content.matchAll(/["'`](src\/[^"'`]+)["'`]/g)];
  for (const m of fileRefs) {
    const target = join(ROOT, m[1]);
    try {
      statSync(target);
    } catch {
      // Try with .ts extension (common oversight)
      try {
        statSync(target + ".ts");
      } catch {
        // Try with .mjs extension
        try {
          statSync(target + ".mjs");
        } catch {
          // Might be a dist/*.js path — check source
          const distMatch = m[1].match(/^dist\/(.+)\.js$/);
          if (distMatch) {
            const src = join(ROOT, "src", distMatch[1]);
            const srcTs = src + ".ts";
            const srcIndex = join(src, "index.ts");
            try { statSync(srcTs); continue; } catch { /* */ }
            try { statSync(srcIndex); continue; } catch { /* */ }
          }
          issues.push({ type: "stale_test_ref", file: rel, import: m[1] });
        }
      }
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

if (issues.length === 0) {
  console.log(`✅ Dependency check clean — ${TS_FILES.length} source files, ${TEST_FILES.length} test files`);
  process.exit(0);
}

console.error(`❌ Dependency check — ${issues.length} issue(s):\n`);
for (const issue of issues) {
  switch (issue.type) {
    case "missing":
      console.error(`  MISSING: ${issue.file} → "${issue.import}"`);
      break;
    case "stale_test_ref":
      console.error(`  STALE:   ${issue.file} → "${issue.import}"`);
      break;
  }
}
console.error(`\nRun: node scripts/check-deps.mjs`);
process.exit(1);
