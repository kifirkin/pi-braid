#!/usr/bin/env node
/**
 * Source Marker Gate
 *
 * Fails on unresolved work markers (`TODO`, `FIXME`, `TBD`, `HACK`, `XXX`)
 * anywhere in package source, tests, or markdown. A marker is a promissory
 * note: it says something is unfinished but gives no owner, no ticket, and no
 * deadline, so it ages silently and no one hears it expire. This gate makes
 * the next one loud at commit time.
 *
 * The vocabulary is the in-product verifier's code-safety set
 * (metacognition/handlers/verify.ts): a marker the agent is told to resolve
 * is the same marker this gate rejects at commit time.
 *
 * A marker legitimately stays when it is not a marker at all: the scanner
 * that detects markers must name them, and prose may mention `TODO` as a
 * noun. Those lines live in ALLOW below, each with a stated reason. An entry
 * matches a single line, so a new real marker in the same file still fails.
 *
 * Scope:
 *   - code: `packages/<pkg>/src/**` and `packages/<pkg>/test/**`
 *     (.ts, .tsx, .mts, .cts, .mjs, .js, .cjs)
 *   - markdown: `packages/**\/*.md`
 * `scripts/` is excluded by decision, not oversight: it holds tooling that
 * defines and documents the marker patterns (this scanner lives there), so
 * allowing it would only create pattern lines for the gate to exempt.
 * Shipped source, tests, and docs are the contract.
 *
 * A line is clean if it has no marker token, or if some ALLOW entry for that
 * file matches it. Exit 0 clean, 1 on any unallowlisted marker.
 *
 * Usage: node packages/core/scripts/check-source-markers.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles, DEFAULT_SKIP_DIRS } from "./lib/collect-files.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script is at packages/core/scripts/, so the monorepo root is 3 levels up.
const root = resolve(__dirname, "..", "..", "..");
const packagesDir = resolve(root, "packages");

const MARKER_RE = /\b(TODO|FIXME|TBD|HACK|XXX)\b/;

const SKIP_DIRS = new Set([...DEFAULT_SKIP_DIRS, "scripts"]);
const CODE_RE = /\.(ts|tsx|mts|cts|mjs|js|cjs)$/;

/**
 * Lines that contain a marker token without being an unresolved marker.
 * `file` is repo-relative; `match` tests the line text; `reason` is the
 * one-line justification a reader needs to trust the exemption.
 */
const ALLOW = [
  {
    file: "packages/core/src/extensions/cognitive/metacognition/handlers/verify.ts",
    match: /TODO[/|]FIXME/,
    reason: "the marker detector's own pattern and message text",
  },
  {
    file: "packages/core/AGENTS.md",
    match: /simple TODO list/,
    reason: "prose: names the task-list facility, not an unfinished item",
  },
];

const allowedBy = new Map();
for (const entry of ALLOW) {
  if (!allowedBy.has(entry.file)) allowedBy.set(entry.file, []);
  allowedBy.get(entry.file).push(entry);
}

function inScopeFiles() {
  const files = [];
  let packages;
  try {
    packages = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue;
    const base = resolve(packagesDir, pkg.name);
    for (const sub of ["src", "test"]) {
      files.push(...collectFiles(resolve(base, sub), (f) => CODE_RE.test(f), { skipDirs: SKIP_DIRS }));
    }
    files.push(...collectFiles(base, (f) => f.endsWith(".md"), { skipDirs: SKIP_DIRS }));
  }
  return files;
}

const issues = [];
for (const file of inScopeFiles()) {
  const rel = relative(root, file).split("\\").join("/");
  const allowances = allowedBy.get(rel) ?? [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!MARKER_RE.test(lines[i])) continue;
    if (allowances.some((entry) => entry.match.test(lines[i]))) continue;
    issues.push({ file: rel, line: i + 1, text: lines[i].trim() });
  }
}

if (issues.length === 0) {
  console.log(`check-source-markers: clean (${ALLOW.length} allowed line pattern(s))`);
  process.exit(0);
}

console.error(`check-source-markers: ${issues.length} unresolved marker(s)`);
for (const issue of issues) {
  console.error(`  ${issue.file}:${issue.line}: ${issue.text}`);
}
console.error();
console.error("Resolve the marker, delete it, or add an ALLOW entry with a reason.");
process.exit(1);
