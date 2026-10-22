#!/usr/bin/env node
/**
 * check-placement.mjs — report where a fact sits in the wrong layer.
 *
 * Three classes of placement leak, scanned over the tracked tree
 * (`git ls-files`; content read from the working tree):
 *
 *   1. provenance-token — wave/round/process labels, ISO dates, and commit
 *      hashes in comments and string literals. History lives in git; a
 *      future reader has no context for these. Runtime strings are in scope
 *      because a comments-only pass leaves them behind.
 *   2. domain-literal — the role words `orchestrator` / `worker` used as
 *      policy (cwd gates, hardcoded roots, role classification) inside
 *      packages/core/src. The domain owners and the tool surface are listed
 *      in EXCLUSIONS with a reason each.
 *   3. owner-path — concrete home paths (/Users/<name>/, /home/<name>/,
 *      --Users-<name>, --home-<name>). Placeholder forms (`<user>`, `...`)
 *      are not leaks: they document the shape without naming a machine.
 *
 * Modes:
 *   node packages/core/scripts/check-placement.mjs            report-only, exit 0
 *   node packages/core/scripts/check-placement.mjs --strict   exit 1 on any hit or
 *                                                            an over-budget exclusion list
 *
 * Scope decisions:
 *   - Class 1 reads comments and string literals of code files. Prose docs
 *     and generated lockfiles are out of scope: the CHANGELOG records release
 *     history on purpose, and an integrity hash is not provenance.
 *   - Class 3 reads every tracked text file, because a home path leaks
 *     wherever it sits.
 *   - EXCLUSIONS are (path, class) pairs with a reason, applied before
 *     printing. Excluded paths are summarized with hit counts, never
 *     itemized; the exclusion list stays auditable and no class disappears
 *     from the report. The list shrinks only by hand, so it is capped by
 *     EXCLUSION_BUDGET: strict mode fails when it grows past the cap, and
 *     raising the cap is a deliberate, review-visible edit to the constant.
 *
 * The summary line carries the population scan's three facts, because it is
 * the printed source a population stamp is transcribed from: the files read,
 * the enumerated population the run was over (the index it walked, via
 * `git ls-files`), and the revision the scan certifies (the branch the tree
 * is on, or the short sha when HEAD is detached; a branch is the destination
 * a pre-commit run certifies, while the moment's own sha equals the pre-staging
 * index and could never show the gap). The merge path compares a stamped
 * population against that revision's census, so both numbers and the revision
 * belong on the line.
 *
 * This script defines the pattern literals it searches for, so it skips
 * itself (the same convention check-doc-links.mjs uses).
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script is at packages/core/scripts/ — monorepo root is 3 levels up.
const root = resolve(__dirname, "..", "..", "..");
const selfPath = resolve(fileURLToPath(import.meta.url));
const strict = process.argv.includes("--strict");

/**
 * Files whose comments and string literals class 1 reads. The pattern admits
 * code extensions only, so markdown is out of class-1 scope: a
 * backlog-reference token in a `.md` file is never scanned, and a green run is
 * not evidence that the class is absent from the docs.
 */
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

// ── Class 1 patterns ────────────────────────────────────────────────────────
// Each pattern carries its intent; keep matches word-bounded so identifiers
// and ordinary prose do not trip a class.

const PROVENANCE_PATTERNS = [
  {
    id: "wave-token",
    regex: /\bW(?:\d{1,3}|-[A-Z])\b/g,
    intent: "wave identifier (W + digits, or W-X) — internal process metadata",
    // ISO-week labels (2026-W35, and ranges like W35..W38) are calendar
    // data, not wave provenance; a test fixture about weeks must not read
    // as a leak.
    isoWeekGuard: true,
  },
  {
    id: "worker-token",
    // The trailing-w alternative is the lowercase wave label (w21w); without
    // it \bw\d{1,3}\b backtracks at the second w and the token escapes.
    regex: /\bw\d{1,3}(?:w|-[a-z][\w-]*)?\b/g,
    intent:
      "worker/task slug (w78, w90-pausebtn) or lowercase wave label (w21w) — internal task metadata",
    // Lowercase w-tags in strings are usually fixture labels (session ids,
    // temp dirs), so the comment surface carries the provenance signal.
    commentsOnly: true,
  },
  {
    id: "wave-word",
    regex: /\b[Ww]ave(?:\b|[-\s]?\d)/g,
    intent: "wave label in prose (wave, wave-4, wave 3) — internal process metadata",
  },
  {
    id: "iso-date",
    regex: /\b20\d\d-\d\d-\d\d\b/g,
    intent: "change-history date — git carries this, comments do not need it",
  },
  {
    id: "round-label",
    // Work-round labels carry the flavor suffix (round 21f); bare "round N"
    // is retry/attempt prose (round 1 raw bytes, round 2 amplified), so the
    // suffix is the discriminator.
    regex: /\bround\s+\d+[a-z]\b/gi,
    intent: "work-round label with flavor suffix (round 21f) — internal process metadata",
  },
  {
    id: "phase-label",
    regex: /\bphase[-\s]?\d+(?:\.\d+)?\b/gi,
    intent: "refactor phase label (phase-3) — protocol stage names (Phase 1 (CoreInit)) stay legal",
    phaseRule: true,
  },
  {
    id: "commit-ref",
    regex: /\b(?:commit|sha)\s+[0-9a-f]{5,40}\b/gi,
    intent: "commit/sha citation — the hash says nothing to a future reader",
  },
  {
    id: "backlog-ref",
    // The item number is the discriminator: prose uses of the word ("a
    // standing backlog") stay legal, as does a reference to a backlog item
    // with no number. `§N` and bare `N` are item numbers; `pl-` ids are
    // backlog task ids; a slash list (16e/16f) is one reference.
    regex: /\bbacklog(?:[\s-]+items?)?[\s-]*(?:§\s*)?(?:\d+[a-z]?(?:\s*\/\s*\d+[a-z]?)*|pl-[a-z0-9][\w-]*)/gi,
    intent:
      "internal backlog item reference (backlog item 22, backlog §20) — the artifact lives outside the repo; restate the mechanism",
  },
  {
    id: "backlog-letter-ref",
    // Case-sensitive by design: the numeric pattern is case-insensitive, but
    // a lettered id needs the capital to stay a discriminator, so lowercase
    // prose ("the backlog can grow") does not trip the gate.
    regex: /\bbacklog\s+[A-Z](?![\w-])/g,
    intent: "lettered internal backlog reference (backlog C) — internal process metadata",
  },
];

// A phase label is flagged in its process form: hyphenated (phase-3), or
// sharing a comment with a refactor action. Named protocol stages
// (Phase 1 (CoreInit), Phase 2 (analysis)) are the tool's own vocabulary.
const PHASE_PROCESS_CUE =
  /\b(?:residual|refactor\w*|split|remov(?:e|ed|al)|replacement|fold(?:ed|s)?)\b/i;

// ── Class 2 configuration ───────────────────────────────────────────────────

const DOMAIN_LITERAL = /\b(?:orchestrator|worker)\b/gi;
const DOMAIN_SCOPE = "packages/core/src/";

// ── Class 3 patterns ────────────────────────────────────────────────────────

const USER_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const OWNER_PATH_PATTERNS = [
  { id: "macOS home", regex: new RegExp(`/Users/${USER_SEGMENT}(?![A-Za-z0-9._-])`) },
  { id: "Linux home", regex: new RegExp(`/home/${USER_SEGMENT}(?![A-Za-z0-9._-])`) },
  { id: "slugged home", regex: new RegExp(`--(?:Users|home)-${USER_SEGMENT}(?![A-Za-z0-9._-])`) },
];

// ── Exclusions ──────────────────────────────────────────────────────────────────────────
// A path entry is a file, or a directory when it ends with `/`. `classes`
// limits the exclusion; omit it to exclude the path from every class.

const EXCLUSIONS = [
  {
    path: "packages/core/src/lib/orchestrator/",
    classes: ["domain-literal"],
    reason: "owns the orchestration domain (file locks, worker registry, branch merge)",
  },
  {
    path: "packages/core/src/extensions/orchestrator/",
    classes: ["domain-literal"],
    reason: "the `orchestrate` tool surface",
  },
  {
    path: "packages/core/src/extensions/manifest.ts",
    classes: ["domain-literal"],
    reason: "extension registry — wires every extension by id, as check-deps.mjs exempts it",
  },
  {
    path: "packages/core/src/extensions/core/prompt-builder/tool-guidelines.ts",
    classes: ["domain-literal"],
    reason: "tool reflection text; must mirror TOOLS.md entries, orchestrate included",
  },
  {
    path: "packages/core/src/lib/config/braid-paths.ts",
    classes: ["domain-literal"],
    reason: "single home for braid state paths; lock/worker registries are braid-wide state",
  },
  {
    path: "packages/core/src/lib/config/braid-settings.ts",
    classes: ["domain-literal"],
    reason:
      "the braid.* settings-key registry: a section name is a key path (`braid.orchestrator.*`), not policy, so naming the owning section is the file's content",
  },
  {
    path: "packages/core/src/lib/orchestrator/slop-scanner.ts",
    classes: ["wave-word", "round-label", "phase-label"],
    reason: "defines the detector's pattern ids and intent examples — its own vocabulary",
  },
  {
    path: "packages/core/test/runtime/lib/test-memory-junk-scan.mjs",
    classes: ["iso-date"],
    reason: "fixture dates are the scan data under test (--since boundaries, timeline)",
  },
  {
    path: "packages/core/test/runtime/lib/test-memory-write-log-metrics.mjs",
    classes: ["iso-date", "wave-token"],
    reason: "week labels and timestamps are the subject under test",
  },
  {
    path: "packages/core/test/runtime/lib/test-local-time.mjs",
    classes: ["iso-date"],
    reason: "formatted local-time strings are exact expectations under test",
  },
  {
    path: "packages/telegram/test/local-time.test.mjs",
    classes: ["iso-date"],
    reason: "formatted local-time strings are exact expectations under test",
  },
  {
    path: "packages/core/scripts/check-labels.mjs",
    classes: ["wave-word", "wave-token"],
    reason: "defines the label gate's own wave vocabulary in its header and message (same convention as slop-scanner.ts)",
  },
  {
    path: "packages/core/src/extensions/core/prompt-builder/surface-discipline-section.ts",
    classes: ["wave-word"],
    reason: "the prohibition text names the label class it forbids; the block is pinned verbatim by a lockstep test",
  },
  {
    path: "packages/core/src/extensions/core/prompt-builder/identity.ts",
    classes: ["domain-literal"],
    reason: "SELF_MANAGEMENT prompt prose names the worker role to the agent; it is prompt content, not a cwd gate or role classifier",
  },
  {
    path: "packages/core/test/runtime/lib/test-slop-scanner.mjs",
    classes: ["wave-word"],
    reason: "wave tokens are the scanner fixture data under test",
  },
  {
    path: "packages/core/test/runtime/memory/test-session-recall-analyze-bounds.mjs",
    classes: ["iso-date"],
    reason: "fixture session content and file names carry the dates the digest renders",
  },
  {
    path: "packages/core/test/runtime/memory/test-session-recall-analyze-whispers.mjs",
    classes: ["iso-date"],
    reason: "fixture session file names carry the dates the digest renders",
  },
  {
    path: "packages/core/test/runtime/memory/test-session-paths-and-stats.mjs",
    classes: ["iso-date"],
    reason: "fixture session file names and the pinned archive mtime are the date-decoding data under test",
  },
  {
    path: "packages/core/test/runtime/memory/test-session-archive-search.mjs",
    classes: ["owner-path"],
    reason: "fixture tree models an encoded session directory; the user segment is a synthetic label",
  },
  {
    path: "packages/core/test/runtime/memory/test-session-query-terms.mjs",
    classes: ["owner-path"],
    reason: "fixture tree models an encoded session directory; the user segment is a synthetic label",
  },
  {
    path: "packages/core/test/runtime/memory/test-session-ranking.mjs",
    classes: ["owner-path"],
    reason: "fixture tree models an encoded session directory; the user segment is a synthetic label",
  },
  {
    path: "packages/core/test/runtime/memory/test-session-search-cost.mjs",
    classes: ["owner-path"],
    reason: "fixture tree models an encoded session directory; the user segment is a synthetic label",
  },
];

// ── Exclusion budget ────────────────────────────────────────────────────────
// EXCLUSIONS is hand-justified and only shrinks by hand; nothing else keeps
// it from growing one plausible-looking entry at a time. The budget is the
// ratchet: strict mode fails when the list exceeds it. Raising the number is
// a deliberate edit to this constant, visible in review, never a side effect
// of adding an entry.
const EXCLUSION_BUDGET = 22;

// ── File collection ──────────────────────────────────────────────────────────────────────

function trackedFiles() {
  try {
    return execSync("git ls-files", { cwd: root, encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    const content = readFileSync(resolve(root, file), "utf-8");
    return content.includes("\0") ? undefined : content; // binary
  } catch {
    return undefined; // unreadable — skip
  }
}

// ── Comment / string extraction ─────────────────────────────────────────────
// A small lexical pass over each source file, so class 1 sees comments and
// string literals only. Regex literals are skipped with the standard
// "expression position" heuristic; a misread would cost precision, never
// correctness of the file itself.

function isRegexStart(prev) {
  return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

/** Collect {kind, line, text} spans for comments and strings. */
function collectSpans(source) {
  const spans = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let prev = "";

  const push = (kind, text, startLine) => {
    if (text.length > 0) spans.push({ kind, line: startLine, text });
  };

  while (i < n) {
    const ch = source[i];

    if (ch === "/" && source[i + 1] === "/") {
      const start = i;
      const startLine = line;
      while (i < n && source[i] !== "\n") i++;
      push("comment", source.slice(start + 2, i), startLine);
      prev = "/";
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      const start = i;
      const startLine = line;
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        i++;
      }
      push("comment", source.slice(start + 2, i), startLine);
      i += 2;
      prev = "/";
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = i;
      const startLine = line;
      i++;
      while (i < n) {
        const c = source[i];
        if (c === "\\") {
          if (source[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (c === "\n") {
          line++;
          i++;
          if (quote !== "`") break; // unterminated single-line string
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      const end = source[i - 1] === quote ? i - 1 : i;
      push("string", source.slice(start + 1, end), startLine);
      prev = quote;
      continue;
    }

    if (ch === "/" && isRegexStart(prev)) {
      i++;
      let inClass = false;
      while (i < n) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "\n") break; // unterminated regex ends at the line
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i++;
          break;
        }
        i++;
      }
      prev = "/";
      continue;
    }

    if (ch === "\n") {
      line++;
      prev = "";
      i++;
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }

  return spans;
}

// ── Class 1 scan ────────────────────────────────────────────────────────────

function isoWeekContext(text, index, match) {
  const window = text.slice(Math.max(0, index - 12), index + match.length + 12);
  return /20\d\d-W\d{1,2}/.test(window) || /W\d{1,2}\.\.W\d{1,2}/.test(window);
}

// Meta-mentions name the label itself ("wave-token", "wave label", "wave or
// phase labels") rather than carrying one; the prompt text and the slop
// scanner's own vocabulary must stay legal.
function metaWaveMention(text, match) {
  const after = text.slice(match.index + match[0].length);
  return /^[\s-](?:token|word|label|or)\b/i.test(after);
}

function scanProvenance(file, source, findings) {
  for (const span of collectSpans(source)) {
    let spanLine = span.line;
    for (const text of span.text.split("\n")) {
      for (const pattern of PROVENANCE_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match;
        while ((match = pattern.regex.exec(text)) !== null) {
          if (pattern.isoWeekGuard && isoWeekContext(text, match.index, match[0])) continue;
          if (pattern.commentsOnly && span.kind !== "comment") continue;
          if (pattern.id === "wave-word" && metaWaveMention(text, match)) continue;
          if (pattern.phaseRule && !match[0].includes("-") && !PHASE_PROCESS_CUE.test(span.text)) {
            continue;
          }
          findings.push({
            class: "provenance-token",
            kind: pattern.id,
            file,
            line: spanLine,
            excerpt: text.trim().slice(0, 120),
            spanKind: span.kind,
          });
          if (match.index === pattern.regex.lastIndex) pattern.regex.lastIndex++;
        }
      }
      spanLine++;
    }
  }
}

// ── Class 2 scan ────────────────────────────────────────────────────────────────────────

function scanDomainLiterals(file, source, findings) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    DOMAIN_LITERAL.lastIndex = 0;
    const match = DOMAIN_LITERAL.exec(lines[i]);
    if (!match) continue;
    findings.push({
      class: "domain-literal",
      kind: match[0].toLowerCase(),
      file,
      line: i + 1,
      excerpt: lines[i].trim().slice(0, 120),
    });
  }
}

// ── Class 3 scan ────────────────────────────────────────────────────────────

function scanOwnerPaths(file, source, findings) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { id, regex } of OWNER_PATH_PATTERNS) {
      const match = lines[i].match(regex);
      if (!match) continue;
      findings.push({
        class: "owner-path",
        kind: id,
        file,
        line: i + 1,
        excerpt: `${match[0]} in: ${lines[i].trim().slice(0, 80)}`,
      });
      break;
    }
  }
}

// ── Exclusion handling ──────────────────────────────────────────────────────

function exclusionFor(finding) {
  return EXCLUSIONS.find(
    (entry) =>
      (finding.file === entry.path || finding.file.startsWith(entry.path)) &&
      (!entry.classes ||
        entry.classes.includes(finding.class) ||
        entry.classes.includes(finding.kind)),
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────

const files = trackedFiles();
const findings = [];
let scanned = 0;

for (const file of files) {
  if (resolve(root, file) === selfPath) continue; // defines its own patterns
  const source = readText(file);
  if (source === undefined) continue;
  scanned++;

  if (CODE_FILE.test(file)) {
    scanProvenance(file, source, findings);
    if (file.startsWith(DOMAIN_SCOPE)) scanDomainLiterals(file, source, findings);
  }
  scanOwnerPaths(file, source, findings);
}

const reported = [];
const excludedCounts = new Map(); // exclusion entry -> hit count
for (const finding of findings) {
  const exclusion = exclusionFor(finding);
  if (exclusion) {
    excludedCounts.set(exclusion, (excludedCounts.get(exclusion) ?? 0) + 1);
  } else {
    reported.push(finding);
  }
}

const classes = ["provenance-token", "domain-literal", "owner-path"];
const byClass = new Map(classes.map((c) => [c, []]));
for (const finding of reported) byClass.get(finding.class).push(finding);

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * The revision the scan certifies: the branch the tree is on, or the short
 * sha when HEAD is detached. A branch names the destination a run made before
 * the commit will land on, which is the revision whose census the merge path
 * can compare; the moment's own sha is the pre-staging index's twin, so a
 * stamp naming it matches by construction and the one-file gap never shows.
 */
function scannedRevision() {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root,
      encoding: "utf-8",
    }).trim();
    if (branch && branch !== "HEAD") return branch;
    return execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

const mode = strict ? "strict" : "report-only";
console.log(
  `Placement check (${mode}) — ${scanned} tracked files scanned of ${files.length} ` +
    `tracked at ${scannedRevision()}`,
);

for (const className of classes) {
  const hits = byClass.get(className);
  if (hits.length === 0) {
    console.log(`  ${className}: 0 hits`);
    continue;
  }
  const filesWithHits = new Set(hits.map((h) => h.file)).size;
  console.log(`  ${className}: ${hits.length} hits in ${filesWithHits} files`);
  for (const hit of hits) {
    const kind = hit.kind ? `${hit.kind}${hit.spanKind ? `/${hit.spanKind}` : ""} ` : "";
    console.log(`    ${hit.file}:${hit.line}  [${kind.trim()}] ${hit.excerpt}`);
  }
}

const excludedTotal = [...excludedCounts.values()].reduce((a, b) => a + b, 0);
const budgetExceeded = EXCLUSIONS.length > EXCLUSION_BUDGET;

console.log(`\n  Exclusion budget: ${EXCLUSIONS.length}/${EXCLUSION_BUDGET} entries used`);
if (EXCLUSIONS.length > 0) {
  console.log(`  Documented exclusions (${EXCLUSIONS.length}):`);
  for (const entry of EXCLUSIONS) {
    const count = excludedCounts.get(entry) ?? 0;
    console.log(`    ${entry.path} [${(entry.classes ?? classes).join(", ")}] — ${count} hit(s)`);
    console.log(`      reason: ${entry.reason}`);
  }
  console.log(`  Excluded hits: ${excludedTotal}`);
}

console.log(`\n  Totals: ${reported.length} hit(s) reported, ${excludedTotal} excluded`);

if (budgetExceeded) {
  console.log(
    `\n  Exclusion budget exceeded: ${EXCLUSIONS.length} entries > ${EXCLUSION_BUDGET}. ` +
      "The list shrinks by hand; a budget bump is a deliberate edit.",
  );
}

if (reported.length > 0 || budgetExceeded) {
  const reasons = [
    reported.length > 0 ? `${reported.length} reported hit(s)` : null,
    budgetExceeded ? "exclusion list over budget" : null,
  ]
    .filter(Boolean)
    .join("; ");
  console.log(
    strict
      ? `\n  Placement check... FAIL (strict: ${reasons})`
      : "\n  Placement check... report-only (exit 0; pass --strict to fail on hits or an over-budget exclusion list)",
  );
  process.exit(strict ? 1 : 0);
}

console.log("\n  Placement check... PASS");
process.exit(0);
