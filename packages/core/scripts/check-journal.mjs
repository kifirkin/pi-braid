#!/usr/bin/env node
/**
 * check-journal — the structural and currency instrument for the journal.
 *
 * The seat writes the journal about its own honesty, so a self-report about
 * the journal counts for nothing. This program reads two files no single
 * writer controls: the journal itself (structure, linkage, evidence) and the
 * self-review outcomes log (currency). It is a separate program with its own
 * parser on purpose: a check that imported the writer's validator would
 * inherit whatever the writer silently accepts.
 *
 * Instrument A: structure and evidence. Every finding is one exit-2 shape:
 *   LINE      a line does not parse as JSON
 *   FIELDS    a field is missing, of the wrong type, or not a field of that
 *             kind (a decision without reason, a constraint without
 *             expires_at, a status on an outcome)
 *   TIME      `at` or `expires_at` is not a parseable timestamp
 *   DUP       a seq appears twice
 *   ORDER     seq is not strictly increasing (a regression)
 *   DANGLING  `supersedes` names a seq that is in neither the live file nor a
 *             rotated sibling, or names itself or a later entry
 *   FORK      two entries supersede one entry, leaving two live successors
 *   ABSENT    an evidence path is inside this root and missing, and the entry
 *             is not marked unverified
 *   EVIDENCE  evidence is empty and the entry is not marked unverified
 *   ARCHIVE   a rotated file's last seq is not below the live file's first
 *
 * The journal is a population, not a file. Rotation moves a prefix of the live
 * journal into `journal-<year>.jsonl` beside it (the name is stated once, in
 * the path helper both this program and the writer import), so a reference is
 * resolved across the live file and every rotated sibling. Three readings are
 * informational and never fail a run on their own, because none of them
 * proves an entry false:
 *   ROTATED     a `supersedes` target lives in a rotated sibling
 *   UNRESOLVED  an evidence reference cannot be resolved from this root: it is
 *               absolute, it climbs above the root, or its first component
 *               does not exist here. The root is not the base the entry was
 *               written against, so this tree cannot say the file is gone; it
 *               can only say it cannot read the reference from here
 *   MOVED       the newest entry records a successor journal file, and currency
 *               is read from there
 * A run that exits 0 with UNRESOLVED lines has not shown the entries true; it
 * has shown only that this root cannot adjudicate them. `ABSENT` is the class
 * that would, and it keeps failing the run.
 *
 * Every run ends with one instrument line counting findings by class, so two
 * runs compare directly and a checker that got quieter instead of more honest
 * is visible as a shifted count rather than as an absence of output.
 *
 * A stamp already past is not a finding. The writer refuses one at write time,
 * so a past `expires_at` on disk is a line that aged where it sits: the checker
 * reads a file, not the moment the line was written, and a constraint's window
 * closing is exactly what the field records.
 *
 * Instrument B: currency. The newest outcome line's timestamp must not be
 * later than the newest journal entry's: a task closed with no journal entry
 * for it is the failure the journal exists to prevent. It reports STALE. A
 * journal that moved to a successor is the exception the rule has to read: an
 * entry records the successor by naming a journal file in its evidence, and
 * currency is then read from the later of the two files. A successor that is
 * missing or unreadable excuses nothing, which is the direction that keeps the
 * finding.
 *
 * Usage:
 *   node scripts/check-journal.mjs [--cwd <dir>] [--project <slug>] [--digest]
 *
 * The journal is the project's, not the checkout's: with no --project the slot
 * comes from the directory the run is rooted at, and a linked worktree resolves
 * to the checkout it was branched from, because `git worktree` puts the tree
 * somewhere else and keeps one repository. Evidence references are resolved
 * from the directory the run was given, which is the tree the entries were read
 * in.
 *
 * Exit: 0 clean (informational readings may still print; --digest prints the
 *       open program instead), 2 at least one finding from the list above, 1 an
 *       operational error.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");

function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function loadDist(relative) {
  const file = join(DIST, relative);
  if (!existsSync(file)) {
    die(
      1,
      `check-journal: ${file} is absent; the package is not built. Run \`npm run build\` first.`,
    );
  }
  return import(pathToFileURL(file).href);
}

const { braidDir, journalFilePath, journalRotatedFiles, ROTATED_JOURNAL_NAME } = await loadDist(
  join("lib", "config", "braid-paths.js"),
);
const { projectSlugFromCwd } = await loadDist(
  join("extensions", "memory", "scratchpad", "persistence.js"),
);

// ── The schema this checker enforces ──────────────────────────────────────
//
// Spelled out again rather than imported from the writer: an instrument that
// shares the producer's parser can only find the mistakes the parser already
// knows about. Where the two disagree, this file is the one that decides
// whether a line is admissible, and the disagreement is a bug worth seeing.

const KINDS = new Set(["intent", "decision", "outcome", "constraint", "seat"]);
const STATUSES = new Set(["open", "waiting", "blocked", "done", "dropped", "superseded"]);
const OPEN_STATUSES = new Set(["open", "waiting", "blocked"]);
/** The kinds that may name when they stop applying: the two that describe a
 *  window rather than a fact that already happened. */
const EXPIRY_KINDS = new Set(["intent", "constraint"]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PATH_LIKE = /^[\w.@/-]+\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|json|jsonl|md|sh|ya?ml|toml|txt|py)$/;

/** One test for both stamps the schema carries: the shape the writer emits and
 *  a value `Date` can read. */
const isStamp = (value) =>
  typeof value === "string" && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));

// ── Arguments ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let cwd = process.cwd();
let project = "";
let digest = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--cwd") cwd = resolve(args[++i] ?? "");
  else if (arg === "--project") project = args[++i] ?? "";
  else if (arg === "--digest") digest = true;
  else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "usage: check-journal [--cwd <dir>] [--project <slug>] [--digest]\n" +
        "exit 0 clean, 2 findings " +
        "(LINE|FIELDS|TIME|DUP|ORDER|DANGLING|FORK|ABSENT|EVIDENCE|ARCHIVE|STALE)\n" +
        "informational, never an exit code: ROTATED, UNRESOLVED, MOVED\n",
    );
    process.exit(0);
  } else die(2, `check-journal: unknown argument ${JSON.stringify(arg)}`);
}

/** One git read in a directory, or null when the directory is not in a
 *  repository or the read fails. A checker that shells out to git has company
 *  here; what it must not do is treat a failed read as a fact about the tree. */
function git(dir, argv) {
  try {
    const out = execFileSync("git", ["-C", dir, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * The project a run reads the journal of, when no --project names one.
 *
 * A journal is keyed by the directory a seat works in, and a linked worktree is
 * the same project as the checkout it was branched from: `git worktree` puts the
 * tree somewhere else and keeps one repository. Slugging the worktree's own path
 * would read a second, never-written journal and print a zero population, which
 * is how a gate passes without having read anything. The primary checkout's
 * `.git` sits one level below its working tree and a linked worktree's common
 * directory points back at it, so one rule covers both.
 *
 * A directory outside a repository keeps the directory it was given, and so does
 * a submodule, whose common directory is named after the module rather than
 * `.git`: the submodule's own path is the project there, not its parent's.
 */
function projectDirectory(dir) {
  const toplevel = git(dir, ["rev-parse", "--show-toplevel"]);
  if (toplevel === null) return dir;
  const common = git(dir, ["rev-parse", "--git-common-dir"]);
  if (common === null) return toplevel;
  const commonDir = resolve(toplevel, common);
  if (basename(commonDir) !== ".git") return toplevel;
  return dirname(commonDir);
}

const slug = project || projectSlugFromCwd(projectDirectory(cwd));
const journalFile = journalFilePath(slug);
const outcomesFile = join(braidDir(), "self-review", "outcomes.jsonl");

/** Findings that fail the run: the entry claims something this tree can
 *  falsify, and the tree falsifies it. */
const problems = [];
/** Readings that do not fail it: each one says this root cannot adjudicate the
 *  reference, or names where a reference does resolve. */
const warnings = [];
function finding(shape, detail) {
  problems.push(detail ? `${shape} ${detail}` : shape);
}
function warning(shape, detail) {
  warnings.push(detail ? `${shape} ${detail}` : shape);
}

// ── The rows already in the journal that break this schema ────────────────
//
// The journal is appended to, never rewritten: a line written under an older
// schema stays exactly as it was written, and a correction is a later entry that
// says so. Five such rows are in the live project journal. Each names one seq and
// the class it is about, and a run reports those as DECLARED rather than as
// findings; every other problem still fails it.
//
// The list is data, not a switch: a row excuses one class on one seq, so a second
// problem on the same entry, or the same class on another entry, is reported and
// counted. A declaration that stops matching anything is visible as a falling
// count in the instrument line, not as silence.
const DECLARED_LEGACY = [
  {
    seq: 252,
    shape: "FIELDS",
    why: "an outcome whose subject runs past the 64-character slug the schema now caps",
  },
  {
    seq: 253,
    shape: "EVIDENCE",
    why: "an outcome closed with no evidence and without the unverified flag that would say so",
  },
  {
    seq: 281,
    shape: "FIELDS",
    why: 'an outcome carrying a reason, a field the schema admits on a decision only',
  },
  {
    seq: 282,
    shape: "FIELDS",
    why: 'an entry of kind "finding", which the writer no longer emits',
  },
  {
    seq: 285,
    shape: "FIELDS",
    why: "a decision written before the writer required a reason",
  },
];

// ── Read ──────────────────────────────────────────────────────────────────

const present = existsSync(journalFile);
const rawLines = present ? readFileSync(journalFile, "utf8").split("\n") : [];
const entries = [];
rawLines.forEach((raw, index) => {
  if (!raw.trim()) return;
  try {
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      finding("LINE", `${index + 1}: not a JSON object`);
      return;
    }
    entries.push({ line: index + 1, entry });
  } catch (err) {
    finding("LINE", `${index + 1}: not JSON (${err.message})`);
  }
});

// ── The journal is a population, not one file ────────────────────────────
//
// Rotation moves a prefix of the live file into `journal-<year>.jsonl` beside
// it, so a seq reference is a claim about the journal rather than about a file.
// Which files belong is the path helper's answer, imported here rather than
// spelled again: the writer reads the same list to keep its chain monotonic,
// and two spellings would let the two disagree about where the journal is.
//
// A rotated file is read for its seqs and nothing else. Its structure was gated
// when it was the live file; adjudicating its shape again here would fail a
// record for a rule it never had a chance to meet when it was written.
const rotated = journalRotatedFiles(journalFile).map((file) => {
  const seqs = new Set();
  let last = 0;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const seq = JSON.parse(line)?.seq;
        if (Number.isInteger(seq)) {
          seqs.add(seq);
          last = Math.max(last, seq);
        }
      } catch {
        /* a rotated line's shape is not this run's finding */
      }
    }
  } catch {
    /* an unreadable sibling holds no seq it can resolve */
  }
  return { file, name: basename(file), seqs, last };
});

/** seq -> the rotated file holding it. First in name order wins, so two readers
 *  name one file for one seq. */
const rotatedHolders = new Map();
for (const archive of rotated) {
  for (const seq of archive.seqs) if (!rotatedHolders.has(seq)) rotatedHolders.set(seq, archive.name);
}

// ── Instrument A: structure ───────────────────────────────────────────────

function checkFields({ line, entry }) {
  const where = `line ${line}`;
  if (!KINDS.has(entry.kind)) {
    finding("FIELDS", `${where}: unknown kind ${JSON.stringify(entry.kind)}`);
    return;
  }
  if (typeof entry.subject !== "string" || !SLUG.test(entry.subject)) {
    finding("FIELDS", `${where}: subject is not a stable slug`);
  }
  if (typeof entry.text !== "string" || !entry.text.trim() || /[\r\n]/.test(entry.text)) {
    finding("FIELDS", `${where}: text must be one non-empty line`);
  }
  if (!isStamp(entry.at)) {
    finding("TIME", `seq ${entry.seq}: at ${JSON.stringify(entry.at)} is not an ISO-8601 UTC timestamp`);
  }
  if (!entry.seat || typeof entry.seat !== "object" || Array.isArray(entry.seat)) {
    finding("FIELDS", `${where}: seat provenance is missing`);
  } else {
    for (const key of ["label", "session", "revision"]) {
      if (typeof entry.seat[key] !== "string" || !entry.seat[key]) {
        finding("FIELDS", `${where}: seat.${key} is missing`);
      }
    }
  }
  if (!Array.isArray(entry.evidence)) {
    finding("FIELDS", `${where}: evidence must be an array`);
  } else if (entry.evidence.length === 0 && entry.unverified !== true) {
    finding("EVIDENCE:", `seq ${entry.seq} evidence [] without unverified`);
  }
  if ("unverified" in entry && typeof entry.unverified !== "boolean") {
    finding("FIELDS", `${where}: unverified must be a boolean`);
  }
  if ("status" in entry && entry.status !== null) {
    if (entry.kind !== "intent" && entry.kind !== "constraint") {
      finding("FIELDS", `${where}: status is not a field of ${entry.kind}`);
    } else if (typeof entry.status !== "string" || !STATUSES.has(entry.status)) {
      finding("FIELDS", `${where}: unknown status ${JSON.stringify(entry.status)}`);
    }
  } else if (entry.kind === "intent" || entry.kind === "constraint") {
    finding("FIELDS", `${where}: ${entry.kind} without status`);
  }
  if (entry.kind === "decision") {
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      finding("FIELDS", `${where}: decision without reason`);
    }
  } else if (entry.reason !== null && entry.reason !== undefined) {
    finding("FIELDS", `${where}: reason is not a field of ${entry.kind}`);
  }
  if (entry.kind === "constraint") {
    if (entry.expires_at === null || entry.expires_at === undefined) {
      finding("FIELDS", `${where}: constraint without expires_at`);
    } else if (!isStamp(entry.expires_at)) {
      finding("TIME", `seq ${entry.seq}: expires_at ${JSON.stringify(entry.expires_at)} does not parse`);
    }
  } else if (EXPIRY_KINDS.has(entry.kind)) {
    // Optional on an intent: the deadline is the moment the work stops being
    // worth doing, and every handoff written before the field was admissible
    // carries none, so its absence is a shape rather than a fault.
    if (entry.expires_at !== null && entry.expires_at !== undefined && !isStamp(entry.expires_at)) {
      finding("TIME", `seq ${entry.seq}: expires_at ${JSON.stringify(entry.expires_at)} does not parse`);
    }
  } else if (entry.expires_at !== null && entry.expires_at !== undefined) {
    finding("FIELDS", `${where}: expires_at is not a field of ${entry.kind}`);
  }
}

for (const item of entries) checkFields(item);

// seq: strictly increasing, unique. Both rules in one pass, because a linear
// scan is what makes a regression visible at all.
const seqs = new Set();
let previous = 0;
for (const { line, entry } of entries) {
  if (!Number.isInteger(entry.seq) || entry.seq < 1) {
    finding("FIELDS", `line ${line}: seq is not a positive integer`);
    continue;
  }
  if (seqs.has(entry.seq)) finding("DUP", `seq ${entry.seq}`);
  else if (entry.seq <= previous) finding("ORDER", `seq ${entry.seq} follows ${previous}`);
  seqs.add(entry.seq);
  previous = Math.max(previous, entry.seq);
}

// supersedes: backward, present in the journal, single successor.
const supersededBy = new Map();
for (const { entry } of entries) {
  const target = entry.supersedes;
  if (target === null || target === undefined) continue;
  if (!Number.isInteger(target)) {
    finding("DANGLING", `seq ${entry.seq}: supersedes ${JSON.stringify(target)} is not a seq`);
    continue;
  }
  if (target === entry.seq) {
    finding("DANGLING", `supersedes: seq ${entry.seq} names itself`);
    continue;
  }
  // Present means present in the journal: the live file or a rotated sibling.
  // Those are the only two populations, and a target in neither is the one
  // shape that leaves a successor pointing at nothing.
  const inLive = seqs.has(target);
  const holder = inLive ? undefined : rotatedHolders.get(target);
  if (!inLive && holder === undefined) {
    finding("DANGLING", `supersedes: seq ${entry.seq} names ${target}, absent`);
    continue;
  }
  if (target > entry.seq) {
    finding("DANGLING", `supersedes: seq ${entry.seq} names ${target}, forward`);
    continue;
  }
  const first = supersededBy.get(target);
  if (first !== undefined) {
    finding("FORK:", `seq ${first} and ${entry.seq} both supersede ${target}`);
  } else {
    supersededBy.set(target, entry.seq);
  }
  // A rotated target is not a fault: rotation moved the prefix and the
  // supersession stands. It is reported so a reader knows which file to open,
  // and it changes no exit code.
  if (holder !== undefined) {
    warning("ROTATED", `supersedes: seq ${entry.seq} names ${target}, in ${holder}`);
  }
}

// ── Evidence: what this root can and cannot adjudicate ────────────────────
//
// An evidence reference is a claim about the tree this run is rooted at, and
// resolving one is a walk from that root down its components. Where the walk
// stops is the whole distinction:
//
//   resolved    every component exists: nothing to report.
//   ABSENT      every component above the missing one exists, so this tree is
//               the base the entry was written against and the file it names is
//               gone. This class fails the run.
//   UNRESOLVED  the walk stops at the first component, or the reference is
//               absolute or climbs above the root. The root is not the base, so
//               the tree cannot say the file is missing; it says only that it
//               cannot read the reference from here, and names the root it
//               tried and the raw string it was given.
//
// A command, a sentence or a revision is not a path and is left alone:
// inventing a resolution rule for shapes the journal does not define would fail
// entries for being prose.

/** The path a reference names, or null when it is not a path at all. A suffix
 *  a reader may add (`path:12-40`) is not part of the path. */
function pathOf(reference) {
  if (typeof reference !== "string") return null;
  const value = reference.trim();
  if (!value || /\s/.test(value)) return null;
  const withoutLines = value.replace(/:\d+(?:-\d+)?$/, "");
  return PATH_LIKE.test(withoutLines) ? withoutLines : null;
}

/** Where one path stands against the root this run was given. */
function evidenceVerdict(path) {
  if (path.startsWith("/") || path.startsWith("~")) {
    const full = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
    if (existsSync(full)) return { resolved: true };
    // An absolute reference that lands inside this root is this tree's claim
    // after all, so a missing file there is absent rather than unreadable. One
    // that lands outside it is not this root's to judge, and staying silent
    // about the difference would let an entry escape ABSENT by writing the
    // root's own path in full.
    const inside = relative(cwd, full);
    if (inside && inside !== ".." && !inside.startsWith(`..${sep}`)) return { absent: true };
    return {
      reason: path.startsWith("~")
        ? "home-relative and not on this machine"
        : "absolute and outside this root",
    };
  }
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    return { reason: "climbs above the root" };
  }
  let cursor = cwd;
  for (let index = 0; index < parts.length; index++) {
    cursor = resolve(cursor, parts[index]);
    if (existsSync(cursor)) continue;
    if (index === 0) return { reason: `no ${parts[0]} at the root` };
    return { absent: true };
  }
  return { resolved: true };
}

for (const { entry } of entries) {
  if (!Array.isArray(entry.evidence) || entry.unverified === true) continue;
  for (const reference of entry.evidence) {
    const path = pathOf(reference);
    if (path === null) continue;
    const verdict = evidenceVerdict(path);
    if (verdict.resolved) continue;
    const raw = reference.trim();
    if (verdict.absent) {
      finding("ABSENT", `seq ${entry.seq} names ${raw}, missing under ${cwd} (no unverified flag)`);
    } else {
      warning(
        "UNRESOLVED",
        `seq ${entry.seq} names ${raw}, cannot resolve from ${cwd}: ${verdict.reason}`,
      );
    }
  }
}

// The archive boundary: rotation may only move a prefix, so every rotated seq
// must sit below every live one. A live entry numbered inside an archive is a
// second seq chain, and supersedes would silently resolve across the two.
if (present && entries.length > 0) {
  const liveFirst = entries[0].entry.seq;
  for (const archive of rotated) {
    if (archive.last >= liveFirst) {
      finding("ARCHIVE:", `${archive.name} ends at seq ${archive.last}, live file starts at ${liveFirst}`);
    }
  }
}

// ── Instrument B: currency ────────────────────────────────────────────────

/** Newest timestamp in the outcomes log. A line that does not parse is the
 *  other file's finding, not this one's: skip it and let the log's own gates
 *  speak, rather than failing currency on a shape this program does not own. */
function newestOutcomeAt() {
  if (!existsSync(outcomesFile)) return null;
  let newest = null;
  for (const line of readFileSync(outcomesFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const at = JSON.parse(line).at;
      if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
      if (newest === null || Date.parse(at) > Date.parse(newest)) newest = at;
    } catch {
      /* the outcomes log has its own gate */
    }
  }
  return newest;
}

/** Newest entry in one journal file, read the way the live file is: an
 *  unparseable line is skipped rather than adjudicated, because a successor's
 *  shape is its own run's finding. */
function newestIn(file) {
  let newest = null;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const when = Date.parse(entry?.at);
        if (Number.isNaN(when)) continue;
        if (newest === null || when > Date.parse(newest.at)) newest = entry;
      } catch {
        /* see above */
      }
    }
  } catch {
    return null;
  }
  return newest;
}

// A journal that stopped because the record continues elsewhere. The schema
// carries no successor field, so the pointer is an evidence reference whose
// last component is a journal file name: the one place an entry can already
// record a path. It is read, opened and measured, never interpreted - the
// checker needs a file it can count entries in, not a sentence to believe.
// The live name and the rotated one are the two names a journal has, and the
// rotated half is the helper's constant rather than a second spelling of it.
const LIVE_JOURNAL_NAME = /^journal\.jsonl$/;

function namesAJournal(value) {
  const name = basename(value);
  return LIVE_JOURNAL_NAME.test(name) || ROTATED_JOURNAL_NAME.test(name);
}

function successorOf(entry) {
  if (!entry || !Array.isArray(entry.evidence)) return null;
  for (const reference of entry.evidence) {
    if (typeof reference !== "string") continue;
    const value = reference.trim();
    if (!value || /\s/.test(value)) continue;
    if (!namesAJournal(value)) continue;
    const full = value.startsWith("~")
      ? join(homedir(), value.slice(1))
      : value.startsWith("/")
        ? value
        : resolve(dirname(journalFile), value);
    // A pointer at the live file names no move.
    return resolve(full) === resolve(journalFile) ? null : full;
  }
  return null;
}

const newestEntry = entries.reduce((best, item) => {
  const when = Date.parse(item.entry.at);
  if (Number.isNaN(when)) return best;
  return best === null || when > Date.parse(best.at) ? item.entry : best;
}, null);
const successor = newestEntry === null ? null : successorOf(newestEntry);
const successorNewest = successor === null ? null : newestIn(successor);
if (successor !== null) {
  warning(
    "MOVED",
    `${newestEntry.seq} records the move to ${successor}, whose newest entry is ` +
      (successorNewest === null
        ? "absent or unreadable"
        : `seq ${successorNewest.seq} at ${successorNewest.at}`),
  );
}
/** The entry the outcome log is compared against: the later of the live file's
 *  newest and a recorded successor's, and the live file alone when no successor
 *  is recorded or it cannot be read. A successor that cannot be read excuses
 *  nothing, which is the direction that keeps the finding. */
const horizon =
  successorNewest !== null && Date.parse(successorNewest.at) > Date.parse(newestEntry.at)
    ? successorNewest
    : newestEntry;
const newestOutcome = newestOutcomeAt();
if (newestOutcome !== null) {
  if (newestEntry === null) {
    finding("STALE:", `outcome appended ${newestOutcome} with no journal entry (journal empty)`);
  } else if (Date.parse(newestOutcome) > Date.parse(horizon.at)) {
    finding(
      "STALE:",
      successorNewest === null
        ? `outcome appended ${newestOutcome} with no journal entry since seq ${newestEntry.seq} at ${newestEntry.at}`
        : `outcome appended ${newestOutcome} with no journal entry since seq ${newestEntry.seq} at ${newestEntry.at} or in ${successor}, whose newest is seq ${successorNewest.seq} at ${successorNewest.at}`,
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────────

const bySubject = new Map();
for (const { entry } of entries) {
  if (typeof entry.subject !== "string") continue;
  const list = bySubject.get(entry.subject) ?? [];
  list.push(entry);
  bySubject.set(entry.subject, list);
}

// Derived status: a subject reads as its newest status-bearing entry, and an
// entry named by any later `supersedes` reads as superseded whatever its own
// field says. That derivation is what lets a replacement line change a
// subject's meaning without a byte of the earlier line being rewritten. A
// decision or an outcome carries no status by schema, so it explains a subject
// without closing it; closure is a new status line on the same subject.
const supersededSeqs = new Set();
for (const { entry } of entries) {
  if (Number.isInteger(entry.supersedes)) supersededSeqs.add(entry.supersedes);
}

function derivedStatus(list) {
  let carrier = null;
  for (const candidate of list) if (typeof candidate.status === "string") carrier = candidate;
  if (!carrier) return null;
  return supersededSeqs.has(carrier.seq) ? "superseded" : carrier.status;
}

// ── Report ────────────────────────────────────────────────────────────────

/** Class of one finding line: the token that names its shape. */
function classOf(line) {
  return line.split(/[:\s]/, 1)[0];
}

const CENSUS = ["ABSENT", "UNRESOLVED", "ROTATED", "DANGLING"];

/** The seq a problem is about, or null when it is about no single entry.
 *
 * Two shapes reach here. A field problem names the line it was found on, which
 * this run can map back through the entries it parsed; every other class names
 * the seq it is about. A line that does not parse and an archive boundary name
 * neither, so neither can be declared: there is no row to name. A problem about
 * two entries is attributed to the first seq it names, which is the entry the
 * finding is reported under. */
function attributedSeq(line) {
  const byLine = /^FIELDS line (\d+):/.exec(line);
  if (byLine) {
    const found = entries.find((item) => item.line === Number(byLine[1]));
    return found === undefined ? null : Number(found.entry.seq);
  }
  const named = /(?:^|[ :])seq (\d+)/.exec(line);
  return named === null ? null : Number(named[1]);
}

/** The problems split into the ones a declared row excuses and the ones that
 *  fail the run. The class has to match as well as the seq: a declared entry that
 *  acquires a different problem is a line somebody edited, and editing a journal
 *  is not how its record changes. */
const excused = [];
const failing = [];
for (const line of problems) {
  const seq = attributedSeq(line);
  const row =
    seq === null
      ? undefined
      : DECLARED_LEGACY.find((candidate) => candidate.seq === seq && candidate.shape === classOf(line));
  if (row === undefined) failing.push(line);
  else excused.push({ line, row });
}

/** The instrument line every run ends with. The four classes this reading is
 *  about are counted by name; everything else is counted together, so no
 *  finding goes uncounted by being unlisted and two runs compare directly. The
 *  declared count is part of it for the same reason: a declaration that stops
 *  matching shows up as a falling number rather than as a quiet run. */
function instrumentLine() {
  const counts = new Map();
  for (const line of [...problems, ...warnings]) {
    const name = classOf(line);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const named = CENSUS.map((name) => `${name} ${counts.get(name) ?? 0}`).join(", ");
  const other = (lines) => lines.filter((line) => !CENSUS.includes(classOf(line))).length;
  const declared =
    DECLARED_LEGACY.length === 0 ? "" : `; declared ${excused.length} of ${DECLARED_LEGACY.length}`;
  return `findings: ${named}; other problems ${other(problems)}, other warnings ${other(warnings)}${declared}`;
}

function emit(lines) {
  for (const line of lines) process.stdout.write(`${line}\n`);
}

/** A declared row is reported, not hidden: it names the seq, the problem and the
 *  reason the row was written that way. */
function emitDeclared() {
  for (const { line, row } of excused) {
    process.stdout.write(`DECLARED seq ${row.seq} ${line} (${row.why})\n`);
  }
}

if (digest) {
  if (failing.length > 0) {
    emitDeclared();
    emit(failing);
    emit(warnings);
    emit([instrumentLine()]);
    process.exit(2);
  }
  emitDeclared();
  emit(warnings);
  process.stdout.write(
    `journal ${journalFile}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ` +
      `${bySubject.size} subject${bySubject.size === 1 ? "" : "s"}\n`,
  );
  for (const [subject, list] of bySubject) {
    const status = derivedStatus(list);
    if (!status || !OPEN_STATUSES.has(status)) continue;
    const carrier = list.filter((candidate) => typeof candidate.status === "string").at(-1);
    // An intention whose window closed before this reading is not open work: the
    // checker already reads a past stamp as a line that aged where it sits, and a
    // digest that still called it open would be a second opinion about the same
    // file. A live window is printed with the intention, because when it closes is
    // part of what a successor has to act on.
    if (isStamp(carrier.expires_at) && Date.parse(carrier.expires_at) <= Date.now()) continue;
    const window = isStamp(carrier.expires_at) ? ` (expires ${carrier.expires_at})` : "";
    process.stdout.write(
      `#${carrier.seq} ${carrier.kind}/${status} ${subject}: ${carrier.text}${window}\n`,
    );
    const decision = list.filter((candidate) => candidate.kind === "decision").at(-1);
    if (decision) {
      process.stdout.write(`  decision #${decision.seq}: ${decision.text} (because: ${decision.reason})\n`);
    }
  }
  emit([instrumentLine()]);
  process.exit(0);
}

if (failing.length > 0) {
  emitDeclared();
  emit(failing);
  emit(warnings);
  emit([instrumentLine()]);
  process.exit(2);
}

emitDeclared();
emit(warnings);
const maxSeq = entries.reduce((max, item) => Math.max(max, item.entry.seq ?? 0), 0);
process.stdout.write(
  `journal ${journalFile}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ` +
    `seq to ${maxSeq}, ${bySubject.size} subject${bySubject.size === 1 ? "" : "s"}; ` +
    `outcomes ${newestOutcome === null ? "absent" : `current as of ${newestOutcome}`}\n`,
);
emit([instrumentLine()]);
process.exit(0);
