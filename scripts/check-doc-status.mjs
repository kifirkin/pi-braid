#!/usr/bin/env node
/**
 * Doc Status Marker Enforcer
 *
 * Ensures every in-scope .md file has a `<!-- status: ... -->` HTML
 * comment. The status field is one of:
 *
 *   current         — doc accurately describes the codebase as-is
 *   forward-looking — doc describes planned/target state, not yet shipped
 *   aspirational    — doc describes long-term vision without a concrete plan
 *   historical      — doc describes past state, archived or completed
 *
 * Why this exists: forward-looking prose that lands alongside code without
 * a status marker is invisible drift. AGENTS.md and audit docs that say
 * "we'll do X" while the code does Y create a loop where every "next
 * ticket" silently includes a doc-reconciliation chore that no one tracks.
 * A greppable status marker makes the doc's authority explicit at read time
 * and machine-checkable at commit time.
 *
 * Scope:
 *   - all .md files under docs/ (including docs/archive/)
 *   - all AGENTS.md files under src/
 *   - top-level *.md (AGENTS.md, CHANGELOG.md, CONTRIBUTING.md, README.md)
 *
 * Usage: node scripts/check-doc-status.mjs
 * Exit code: 0 = all in-scope docs have a valid marker, 1 = issues found.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const VALID_STATUSES = new Set([
  "current",
  "forward-looking",
  "aspirational",
  "historical",
]);

// Match <!-- status: ... --> anywhere in the first 80 lines. We don't pin
// the line because some docs have YAML frontmatter or other preamble.
const STATUS_RE = /<!--\s*status:\s*(\S+)\s*-->/;

/**
 * Recursively collect files matching a predicate under a directory.
 * Skips node_modules, dist, and dotfiles.
 */
function collectFiles(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of entries) {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
    const f = join(dir, n);
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...collectFiles(f, predicate));
    } else if (predicate(f)) {
      out.push(f);
    }
  }
  return out;
}

/** Determine the in-scope .md files for this script. */
function collectInScopeDocs() {
  const files = [];

  // 1. docs/**\/*.md (active + archive)
  files.push(
    ...collectFiles(join(ROOT, "docs"), (f) => f.endsWith(".md")),
  );

  // 2. src/**\/AGENTS.md
  files.push(
    ...collectFiles(join(ROOT, "src"), (f) => {
      const rel = relative(ROOT, f);
      return rel.endsWith(`${sep}AGENTS.md`) || rel === `src${sep}AGENTS.md`;
    }),
  );

  // 3. Top-level *.md (AGENTS.md, CHANGELOG.md, CONTRIBUTING.md, README.md)
  const topLevel = ["AGENTS.md", "CHANGELOG.md", "CONTRIBUTING.md", "README.md"];
  for (const name of topLevel) {
    const f = join(ROOT, name);
    try {
      if (statSync(f).isFile()) files.push(f);
    } catch {
      /* not present */
    }
  }

  return files;
}

// ── Main check ──────────────────────────────────────────────────────────────

const files = collectInScopeDocs();
const issues = [];

for (const f of files) {
  const rel = relative(ROOT, f);
  const content = readFileSync(f, "utf8");
  // Search the first 80 lines for the marker. Keeps the regex cheap and
  // avoids false positives in code blocks (which shouldn't appear near
  // the top of a doc anyway).
  const head = content.split("\n").slice(0, 80).join("\n");
  const m = head.match(STATUS_RE);
  if (!m) {
    issues.push({ file: rel, problem: "missing status marker" });
    continue;
  }
  const status = m[1].toLowerCase();
  if (!VALID_STATUSES.has(status)) {
    issues.push({
      file: rel,
      problem: `unknown status: '${status}' (valid: ${[...VALID_STATUSES].join(", ")})`,
    });
  }
}

if (issues.length === 0) {
  console.log(
    `✅ Doc status clean - ${files.length} in-scope docs all have valid status markers`,
  );
  process.exit(0);
}

console.error(`❌ Doc status issues (${issues.length}):\n`);
for (const issue of issues) {
  console.error(`  ${issue.file}: ${issue.problem}`);
}
console.error();
console.error(
  `Add a line near the top of each file, e.g.:\n  <!-- status: current -->`,
);
console.error(`Run: node scripts/check-doc-status.mjs`);
process.exit(1);