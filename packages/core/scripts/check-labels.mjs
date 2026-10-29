#!/usr/bin/env node
// Internal-label gate: fails when internal task labels leak into pi-braid
// sources, tests, or docs.
//
// Scans packages/**/{src,test,scripts}/**/*.{ts,mjs} and packages/**/*.md,
// skipping node_modules, dist, and .git, for:
//   - three-digit handles in either case, optionally with a task suffix
//     (Wnnn[-Tnn], wnnn[-tnn])
//   - brief references (BRIEF- prefixed identifiers)
//
// The three-digit rule is deliberate, not arbitrary: task wave labels in this
// repo always use three digits, while every two-digit Wnn token in the tree
// is an ISO calendar-week reference (2026-W35 strings, the W37/W38 fixture
// constants in test-memory-write-log-metrics.mjs), so a two-to-three-digit
// pattern would flag calendar weeks forever and train people to ignore this
// gate. Two-digit historical task labels are out of scope.
//
// Either case, because that is the spelling the tree carried: a lowercase
// handle in a fixture's session id or temp directory names the same task as the
// uppercase one, and a vocabulary that refused only the uppercase spelling left
// the other in place. The vocabulary is shared with the commit-subject gate and
// lives in lib/label-tokens.mjs, so the two surfaces cannot drift into refusing
// different tokens.
//
// Documented bound: the pattern needs a word boundary on both sides, so a
// handle glued to a letter (some fixture session ids spell one that way) is a
// non-hit, exactly as a four-digit run is. Such a spelling is a fixture to
// rename, not a reason to loosen the vocabulary until it matches every number
// the prose contains.
//
// No config file and no path allowlist: the sanctioned seat for wave context
// (report filenames and titles) lives in the docs repo, outside this scan
// root.
//
// Usage: node scripts/check-labels.mjs
// Exit code: 0 = clean, 1 = leaks found

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles } from "./lib/collect-files.mjs";
import { LABEL_TOKEN_PATTERNS } from "./lib/label-tokens.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Anchor the scan at the repo root so the gate inspects the same tree whether
// it runs from the root (npm run check:labels) or from packages/core.
function findAncestorDir(startDir, predicate) {
  let dir = startDir;
  for (;;) {
    if (predicate(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const REPO_ROOT =
  findAncestorDir(SCRIPT_DIR, (d) => existsSync(join(d, ".git"))) ??
  findAncestorDir(SCRIPT_DIR, (d) => existsSync(join(d, "packages")));
if (!REPO_ROOT) {
  console.error("check-labels: cannot locate the repo root (no .git or packages/ ancestor)");
  process.exit(1);
}
const SCAN_ROOT = join(REPO_ROOT, "packages");

const LABEL_DIRS = new Set(["src", "test", "scripts"]);

const TOKEN_PATTERNS = LABEL_TOKEN_PATTERNS;

function classify(absPath) {
  const name = basename(absPath);
  if (name.endsWith(".md")) return "md";
  if ((name.endsWith(".ts") || name.endsWith(".mjs")) && inLabelDir(absPath)) return "code";
  return null;
}

// Glob semantics of packages/**/{src,test,scripts}/**/*.{ts,mjs}: the file
// must sit below some directory named src, test, or scripts, at any depth
// under the packages root.
function inLabelDir(absPath) {
  const dirSegments = relative(SCAN_ROOT, absPath).split("/").slice(0, -1);
  return dirSegments.some((segment) => LABEL_DIRS.has(segment));
}

function scanContent(content) {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineStarts.push(i + 1);
  }
  const hits = [];
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const index = match.index;
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= index) lo = mid;
        else hi = mid - 1;
      }
      hits.push({ line: lo + 1, col: index - lineStarts[lo] + 1, token: match[0] });
    }
  }
  hits.sort((a, b) => a.line - b.line || a.col - b.col);
  return hits;
}

const files = collectFiles(SCAN_ROOT);
const targets = files
  .filter((file) => classify(file) !== null)
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

let hitCount = 0;
let fileCount = 0;
for (const absPath of targets) {
  const hits = scanContent(readFileSync(absPath, "utf8"));
  if (hits.length === 0) continue;
  fileCount += 1;
  hitCount += hits.length;
  const displayPath = relative(REPO_ROOT, absPath);
  for (const hit of hits) {
    console.log(`${displayPath}:${hit.line}:${hit.col}  ${hit.token}`);
  }
}

if (hitCount > 0) {
  console.log(
    `check-labels: ${hitCount} hits in ${fileCount} file(s); internal task labels found, name the mechanism instead of the wave`,
  );
  process.exit(1);
}
console.log("check-labels: clean (0 hits)");
