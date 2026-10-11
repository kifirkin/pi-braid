#!/usr/bin/env node
/**
 * check-private-data.mjs — scan for private data that should never be committed.
 *
 * Default: whole-tree scan. Every file git can see — tracked plus untracked
 * non-ignored, content read from the working tree — so a leak is caught while
 * it is still dirty, not only once it has been staged or committed.
 *
 *   node packages/core/scripts/check-private-data.mjs
 *
 * Staged-only fast mode (pre-commit): only files staged for commit.
 *
 *   node packages/core/scripts/check-private-data.mjs --staged
 *
 * Checks:
 *   1. .braid/ artifacts tracked by git (session deliverables)
 *   2. Session .jsonl files tracked by git
 *   3. Personal home paths in content — raw (/Users/<name>/, /home/<name>/)
 *      and slugified (--Users-<name>, --home-<name>) — plus this machine's own
 *      $HOME and its slug, so a leak of the current user is always caught
 *   4. Absolute .pi config paths under a user home
 *   5. Secret-shaped API keys (OpenAI-style sk-, GitHub, Slack, AWS, Google)
 *   6. Missing .gitignore patterns
 *
 * Fixture allowance (test files only). The session tests exercise slug
 * parsing, so they must carry slug-shaped paths. A personal-path hit in a
 * test file is allowed only when its user segment is one of
 * SYNTHETIC_USER_SEGMENTS below - names that cannot be a real account. A hit
 * in any other file gets no allowance: the same literal that is a fixture in a
 * test is a leak in src/. Extend the set only with a name that is obviously
 * not a person, and add the reason here.
 *
 * Exit codes:
 *   0 — clean (no private data detected)
 *   1 — private data found
 *   2 — error running checks
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script is at packages/core/scripts/ — monorepo root is 3 levels up
const root = resolve(__dirname, "..", "..", "..");
const selfPath = resolve(fileURLToPath(import.meta.url));

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const issues = [];

function report(category, file, detail) {
  issues.push({ category, file, detail });
}

// ── Check 1: .braid/ deliverables tracked by git ────────────────────────────
const trackedBraid = sh("git ls-files --cached | grep -E '^\\.braid/' || true");
if (trackedBraid) {
  for (const line of trackedBraid.split("\n").filter(Boolean)) {
    report(
      "Private artifact (.braid/)",
      line,
      ".braid/ contains session artifacts — add to .gitignore and remove tracking",
    );
  }
}

// ── Check 2: .jsonl session files tracked by git ────────────────────────────
const trackedJsonl = sh(
  "git ls-files --cached | grep -E '\\.jsonl$' | grep -v node_modules || true",
);
if (trackedJsonl) {
  for (const line of trackedJsonl.split("\n").filter(Boolean)) {
    report(
      "Session file (.jsonl)",
      line,
      ".jsonl files may contain session data — ensure they are gitignored",
    );
  }
}

// ── Content patterns ────────────────────────────────────────────────────────
// A "concrete" user segment starts with an alphanumeric character, so
// documentation placeholders such as `/Users/<user>/...` or `/Users/.../app`
// are not treated as leaks.
const USER_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";

const PERSONAL_PATH_PATTERNS = [
  { re: new RegExp(`/Users/(${USER_SEGMENT})(?![A-Za-z0-9._-])`), label: "macOS home path" },
  { re: new RegExp(`/home/(${USER_SEGMENT})(?![A-Za-z0-9._-])`), label: "Linux home path" },
  { re: new RegExp(`--Users-(${USER_SEGMENT})(?![A-Za-z0-9._-])`), label: "slugified home path" },
  { re: new RegExp(`--home-(${USER_SEGMENT})(?![A-Za-z0-9._-])`), label: "slugified home path" },
];

// A test that parses slugified session paths must contain slug-shaped paths.
// Such a hit is allowed only when its user segment is one of these names,
// which cannot be a real account. Every non-test file gets no allowance.
const SYNTHETIC_USER_SEGMENTS = new Set(["tester", "fixture", "example", "alice", "bob"]);

/** Only a test file may carry slug-shaped fixtures; nothing else may. */
function isTestFile(file) {
  const base = file.split("/").pop() ?? file;
  return (
    file.startsWith("test/") ||
    file.includes("/test/") ||
    /^test-.*\.m?js$/.test(base) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)
  );
}

/** First path-component token of a matched segment (`foo-proj--` -> `foo`). */
function leadingToken(segment) {
  return String(segment ?? "").split(/[^A-Za-z0-9]+/)[0] ?? "";
}

// Absolute .pi paths under a concrete user home. Bare `~/.pi/...` references
// are the documented config location and stay legitimate in docs/comments;
// the leak signal is a user-anchored absolute path into a local config tree.
const DOT_PI_PATTERNS = [
  new RegExp(`/Users/(${USER_SEGMENT})/\\.pi/`),
  new RegExp(`/home/(${USER_SEGMENT})/\\.pi/`),
  new RegExp(`[A-Za-z]:\\\\Users\\\\(${USER_SEGMENT})\\\\.pi\\\\`),
];

const KEY_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: "OpenAI-style API key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: "GitHub token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key ID" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/, label: "Google API key" },
];

if (!process.env.HOME) {
  throw new Error("HOME is unset — set HOME to your home directory");
}
const homeDir = process.env.HOME;
const homeSlug = "--" + homeDir.replace(/^\/+/, "").replace(/\//g, "-");

function personalPathHit(line) {
  // The current machine's own home is never a fixture, in any file: an empty
  // segment cannot be in the synthetic set.
  if (line.includes(homeDir)) return { detail: `Contains absolute path: ${homeDir}`, segment: "" };
  if (line.includes(homeSlug)) {
    return { detail: `Contains slugified home path: ${homeSlug}`, segment: "" };
  }
  for (const { re, label } of PERSONAL_PATH_PATTERNS) {
    const m = line.match(re);
    if (m) return { detail: `${label}: ${m[0]}`, segment: leadingToken(m[1]) };
  }
  return null;
}

function dotPiHit(line) {
  for (const re of DOT_PI_PATTERNS) {
    const m = line.match(re);
    if (m) return { segment: leadingToken(m[1]) };
  }
  return null;
}

const allowedFixtures = [];

function allowFixture(file, lineNum, detail) {
  allowedFixtures.push({ file, lineNum, detail });
}

function scanFileContent(file) {
  const fullPath = resolve(root, file);
  // This file defines the patterns it searches for; scanning it would
  // self-report every pattern literal.
  if (fullPath === selfPath) return;
  if (!existsSync(fullPath)) return;

  let content;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return; // binary or unreadable file — skip
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const testFile = isTestFile(file);
    const isFixture = (segment) => testFile && SYNTHETIC_USER_SEGMENTS.has(segment);

    const personal = personalPathHit(line);
    if (personal) {
      if (isFixture(personal.segment)) {
        allowFixture(file, lineNum, personal.detail);
      } else {
        report("Personal path", `${file}:${lineNum}`, personal.detail);
      }
    }

    const dotPi = dotPiHit(line);
    if (dotPi) {
      if (isFixture(dotPi.segment)) {
        allowFixture(file, lineNum, "Local config path (synthetic fixture)");
      } else {
        report(
          "Local config path",
          `${file}:${lineNum}`,
          "Absolute path into a user's ~/.pi/ local configuration",
        );
      }
    }

    for (const { re, label } of KEY_PATTERNS) {
      const m = line.match(re);
      if (m) {
        report("API key", `${file}:${lineNum}`, `${label} detected (${m[0].slice(0, 12)}...)`);
        break;
      }
    }
  }
}

// ── Check 3: private content in the working tree (or staged files) ──────────
const stagedOnly = process.argv.includes("--staged");
const contentFiles = (
  stagedOnly
    ? sh("git diff --cached --name-only --diff-filter=ACMR")
    : sh("git ls-files --cached --others --exclude-standard")
)
  .split("\n")
  .filter(Boolean);

for (const file of contentFiles) {
  scanFileContent(file);
}

// ── Check 4: Verify .gitignore covers critical patterns ─────────────────────
const gitignorePath = resolve(root, ".gitignore");
if (existsSync(gitignorePath)) {
  const gitignore = readFileSync(gitignorePath, "utf-8");

  const requiredPatterns = [
    { pattern: ".braid/", desc: ".braid/ session artifacts" },
    { pattern: "*.jsonl", desc: "session data files" },
    { pattern: ".tgz", desc: "npm pack artifacts" },
    { pattern: ".env", desc: "environment files (API keys)" },
    { pattern: "dist/", desc: "build output" },
  ];

  for (const { pattern, desc } of requiredPatterns) {
    if (!gitignore.includes(pattern)) {
      report("Missing gitignore entry", ".gitignore", `Missing pattern '${pattern}' for ${desc}`);
    }
  }
} else {
  report("Critical", ".gitignore", ".gitignore file not found at repo root");
}

// ── Output ────────────────────────────────────────────────────────────────────
const scope = stagedOnly ? "staged files" : "working tree";

function printAllowed() {
  console.log(`  Synthetic fixtures allowed: ${allowedFixtures.length} hit(s)`);
  for (const a of allowedFixtures) {
    console.log(`    [${a.detail}] ${a.file}:${a.lineNum}`);
  }
}

if (issues.length === 0) {
  console.log(`  Private data check... PASS (${contentFiles.length} ${scope} scanned)`);
  printAllowed();
  process.exit(0);
}

console.log("  Private data check... FAIL");
console.log(`    ${issues.length} issue(s) found:\n`);

for (const issue of issues) {
  console.log(`    [${issue.category}] ${issue.file}`);
  if (issue.detail) {
    console.log(`      ${issue.detail}`);
  }
}

printAllowed();
console.log("\n    Run `npx gitignore` to update .gitignore patterns.");
console.log("    Run `git rm --cached <file>` to unstage private files.");
process.exit(1);
