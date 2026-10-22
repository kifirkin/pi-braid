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
 * Instrument A — structure. Every finding is one exit-2 shape:
 *   LINE      a line does not parse as JSON
 *   FIELDS    a field is missing, of the wrong type, or not a field of that
 *             kind (a decision without reason, a constraint without
 *             expires_at, a status on an outcome)
 *   TIME      `at` or `expires_at` is not a parseable timestamp
 *   DUP       a seq appears twice
 *   ORDER     seq is not strictly increasing (a regression)
 *   DANGLING  `supersedes` names a seq that does not exist, or names itself or
 *             a later entry
 *   FORK      two entries supersede one entry, leaving two live successors
 *   EVIDENCE  a repo-relative evidence path does not resolve and the entry is
 *             not marked unverified
 *   ARCHIVE   an archive file's last seq is not below the live file's first
 *
 * Instrument B — currency. The newest outcome line's timestamp must not be
 * later than the newest journal entry's: a task closed with no journal entry
 * for it is the failure the journal exists to prevent. It reports STALE.
 *
 * Usage:
 *   node scripts/check-journal.mjs [--cwd <dir>] [--project <slug>] [--digest]
 *
 * Exit: 0 clean (one summary line; --digest prints the open program instead),
 *       2 at least one finding below, 1 an operational error.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const { braidDir, journalFilePath } = await loadDist(join("lib", "config", "braid-paths.js"));
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
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PATH_LIKE = /^[\w.@/-]+\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|json|jsonl|md|sh|ya?ml|toml|txt|py)$/;

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
        "exit 0 clean, 2 findings (LINE|FIELDS|TIME|DUP|ORDER|DANGLING|FORK|EVIDENCE|ARCHIVE|STALE)\n",
    );
    process.exit(0);
  } else die(2, `check-journal: unknown argument ${JSON.stringify(arg)}`);
}

const slug = project || projectSlugFromCwd(cwd);
const journalFile = journalFilePath(slug);
const outcomesFile = join(braidDir(), "self-review", "outcomes.jsonl");

const findings = [];
function finding(shape, detail) {
  findings.push(detail ? `${shape} ${detail}` : shape);
}

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
  if (typeof entry.at !== "string" || !ISO_UTC.test(entry.at) || Number.isNaN(Date.parse(entry.at))) {
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
    } else if (
      typeof entry.expires_at !== "string" ||
      !ISO_UTC.test(entry.expires_at) ||
      Number.isNaN(Date.parse(entry.expires_at))
    ) {
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

// supersedes: backward, present, single successor.
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
  if (!seqs.has(target)) {
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
}

// evidence: repo-relative paths resolve at read time unless the entry says it
// could not verify. A command, an absolute path, a revision or a bare word is
// not a repo-relative path and is left alone: inventing a resolution rule for
// shapes the journal does not define would fail entries for being prose.
function relativePathOf(reference) {
  if (typeof reference !== "string") return null;
  const value = reference.trim();
  if (!value || /\s/.test(value)) return null;
  if (value.startsWith("/") || value.startsWith("~")) return null;
  const withoutLines = value.replace(/:\d+(?:-\d+)?$/, "");
  return PATH_LIKE.test(withoutLines) ? withoutLines : null;
}

for (const { entry } of entries) {
  if (!Array.isArray(entry.evidence) || entry.unverified === true) continue;
  for (const reference of entry.evidence) {
    const relative = relativePathOf(reference);
    if (relative && !existsSync(resolve(cwd, relative))) {
      finding("EVIDENCE:", `seq ${entry.seq} names ${relative}, absent (no unverified flag)`);
    }
  }
}

// The archive boundary: rotation may only move a prefix, so every archived seq
// must sit below every live one. A live entry numbered inside an archive is a
// second seq chain, and supersedes would silently resolve across the two.
if (present) {
  const dir = dirname(journalFile);
  const archives = existsSync(dir)
    ? readdirSync(dir).filter((name) => /^journal-\d{4}\.jsonl$/.test(name))
    : [];
  const liveFirst = entries.length > 0 ? entries[0].entry.seq : null;
  if (liveFirst !== null) {
    for (const name of archives) {
      const archived = readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line).seq;
          } catch {
            return undefined;
          }
        })
        .filter(Number.isInteger);
      const last = archived.reduce((max, seq) => Math.max(max, seq), 0);
      if (last >= liveFirst) {
        finding("ARCHIVE:", `${name} ends at seq ${last}, live file starts at ${liveFirst}`);
      }
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

const newestEntry = entries.reduce((best, item) => {
  const when = Date.parse(item.entry.at);
  if (Number.isNaN(when)) return best;
  return best === null || when > Date.parse(best.at) ? item.entry : best;
}, null);
const newestOutcome = newestOutcomeAt();
if (newestOutcome !== null) {
  if (newestEntry === null) {
    finding("STALE:", `outcome appended ${newestOutcome} with no journal entry (journal empty)`);
  } else if (Date.parse(newestOutcome) > Date.parse(newestEntry.at)) {
    finding(
      "STALE:",
      `outcome appended ${newestOutcome} with no journal entry since seq ${newestEntry.seq} at ${newestEntry.at}`,
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

if (digest) {
  if (findings.length > 0) {
    for (const line of findings) process.stdout.write(`${line}\n`);
    process.exit(2);
  }
  process.stdout.write(
    `journal ${journalFile}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ` +
      `${bySubject.size} subject${bySubject.size === 1 ? "" : "s"}\n`,
  );
  for (const [subject, list] of bySubject) {
    const status = derivedStatus(list);
    if (!status || !OPEN_STATUSES.has(status)) continue;
    const carrier = list.filter((candidate) => typeof candidate.status === "string").at(-1);
    process.stdout.write(`#${carrier.seq} ${carrier.kind}/${status} ${subject}: ${carrier.text}\n`);
    const decision = list.filter((candidate) => candidate.kind === "decision").at(-1);
    if (decision) {
      process.stdout.write(`  decision #${decision.seq}: ${decision.text} (because: ${decision.reason})\n`);
    }
  }
  process.exit(0);
}

if (findings.length > 0) {
  for (const line of findings) process.stdout.write(`${line}\n`);
  process.exit(2);
}

const maxSeq = entries.reduce((max, item) => Math.max(max, item.entry.seq ?? 0), 0);
process.stdout.write(
  `journal ${journalFile}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ` +
    `seq to ${maxSeq}, ${bySubject.size} subject${bySubject.size === 1 ? "" : "s"}; ` +
    `outcomes ${newestOutcome === null ? "absent" : `current as of ${newestOutcome}`}\n`,
);
process.exit(0);
