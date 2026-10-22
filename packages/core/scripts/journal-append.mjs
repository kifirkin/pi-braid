#!/usr/bin/env node
/**
 * journal-append — the only writer of the owner-input journal.
 *
 * One entry is one fact that changes what a replacement seat does: an
 * intention it must honour, a decision it must not re-litigate, an outcome it
 * can trust, a constraint it must re-read. The line is written BEFORE the
 * action it authorises, so a seat killed mid-turn loses thoughts, never
 * commitments.
 *
 * The writer owns what the agent must not be trusted with:
 *   - `seq` — assigned under the same cross-process store lock the scratchpad
 *     uses, monotonic; a payload naming a seq at or below the current maximum
 *     is refused, so a regression or a duplicate cannot enter through this
 *     door.
 *   - `at` — write time, never the payload's.
 *   - `seat` — provenance derived here (session, revision), not claimed by
 *     the agent.
 * A journal whose writer accepts the agent's timestamps and sequence is a
 * diary: it records what the agent felt like saying, in the order it felt like
 * saying it.
 *
 * Field rules are the design's invariants made mechanical: kind determines
 * fields, so a decision without `reason`, a constraint without `expires_at`,
 * or an empty `evidence` list that is not flagged `unverified` is refused
 * before it is written. What the writer cannot judge — whether the sentence is
 * intelligible to a seat that was not there — stays with the checker's reader
 * and the review.
 *
 * Usage: one JSON object on stdin, or `--file <path>`.
 *
 *   node scripts/journal-append.mjs [--cwd <dir>] [--project <slug>]
 *                                   [--seat-label <label>] [--dry-run]
 *
 * Exit: 0 the line was written (printed on stdout as one JSON line),
 *       2 the entry was refused (nothing written), 1 an operational error
 *         (lock timeout, unreadable journal, missing build).
 *
 * Needs the built package (`npm run build`): the path constant and the store
 * lock are imported from `dist/`, never re-implemented here, so the writer
 * cannot drift from the readers or from BRAID_HOME pinning.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");

function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Import a compiled module, failing with the build command rather than a
 *  bare module-not-found: a seat that runs this on an unbuilt checkout should
 *  be told the one command that fixes it. */
async function loadDist(relative) {
  const file = join(DIST, relative);
  if (!existsSync(file)) {
    die(1, `journal-append: ${file} is absent; the package is not built. Run \`npm run build\` first.`);
  }
  return import(pathToFileURL(file).href);
}

const { journalFilePath } = await loadDist(join("lib", "config", "braid-paths.js"));
const { withStoreLock } = await loadDist(join("lib", "memory", "store-lock.js"));
const { projectSlugFromCwd } = await loadDist(
  join("extensions", "memory", "scratchpad", "persistence.js"),
);

// ── The schema this writer enforces ────────────────────────────────────────
//
// Duplicated on purpose in check-journal.mjs: the checker is an independent
// instrument, and one that imported this file's validator would inherit the
// same blind spot. Two spellings of the kind list is cheaper than a gate that
// cannot see what the writer silently accepted.

const KINDS = new Set(["intent", "decision", "outcome", "constraint", "seat"]);
const STATUSES = new Set(["open", "waiting", "blocked", "done", "dropped", "superseded"]);
const FIELDS = new Set([
  "seq",
  "at",
  "kind",
  "subject",
  "text",
  "status",
  "reason",
  "evidence",
  "supersedes",
  "seat",
  "unverified",
  "expires_at",
]);
const SEQUENCING_FIELDS = new Set(["at", "seat"]);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEXT = 400;
const MIN_TEXT = 20;

class Refusal extends Error {}

function refuse(message) {
  throw new Refusal(message);
}

function singleLine(value, field) {
  if (typeof value !== "string") refuse(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) refuse(`${field} is empty`);
  if (/[\r\n]/.test(trimmed)) refuse(`${field} must be one line (a line the checker can read whole)`);
  return trimmed;
}

/** Write-time stamp: ISO-8601 UTC, seconds precision, the shape the checker
 *  parses and the outcome log already uses. */
function writeStamp(now) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function validate(payload, { maxSeq, seqs, supersededBy, now }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    refuse("payload must be one JSON object");
  }
  for (const key of Object.keys(payload)) {
    if (!FIELDS.has(key)) refuse(`unknown field "${key}"`);
    if (SEQUENCING_FIELDS.has(key)) refuse(`${key} is written by the tool, not the payload`);
  }

  const kind = payload.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    refuse(`unknown kind ${JSON.stringify(kind)}`);
  }

  const subject = payload.subject;
  if (typeof subject !== "string" || !SLUG.test(subject)) {
    refuse(`subject ${JSON.stringify(subject)} is not a stable slug`);
  }

  const text = singleLine(payload.text, "text");
  if (text.length < MIN_TEXT) {
    refuse(`text is shorter than ${MIN_TEXT} characters, so it names no fact a reader could act on`);
  }
  if (text.length > MAX_TEXT) refuse(`text is longer than ${MAX_TEXT} characters`);

  const takesStatus = kind === "intent" || kind === "constraint";
  const status = payload.status ?? null;
  if (status !== null) {
    if (!takesStatus) refuse(`status is not a field of ${kind}: kind determines fields`);
    if (typeof status !== "string" || !STATUSES.has(status)) {
      refuse(`unknown status ${JSON.stringify(status)}`);
    }
  } else if (takesStatus) {
    refuse(`${kind} without status`);
  }

  const reason = payload.reason ?? null;
  if (kind === "decision") {
    if (reason === null) refuse("decision without reason");
    const value = singleLine(reason, "reason");
    if (value.length > MAX_TEXT) refuse(`reason is longer than ${MAX_TEXT} characters`);
  } else if (reason !== null) {
    refuse(`reason is not a field of ${kind}: kind determines fields`);
  }

  const expiresAt = payload.expires_at ?? null;
  if (kind === "constraint") {
    if (expiresAt === null) refuse("constraint without expires_at");
    if (typeof expiresAt !== "string" || !ISO_UTC.test(expiresAt)) {
      refuse(`expires_at ${JSON.stringify(expiresAt)} is not an ISO-8601 UTC timestamp`);
    }
    const when = Date.parse(expiresAt);
    if (Number.isNaN(when)) refuse(`expires_at ${JSON.stringify(expiresAt)} does not parse`);
    if (when <= now.getTime()) refuse(`expires_at ${expiresAt} is not in the future`);
  } else if (expiresAt !== null) {
    refuse(`expires_at is not a field of ${kind}: kind determines fields`);
  }

  const unverified = payload.unverified ?? false;
  if (typeof unverified !== "boolean") refuse("unverified must be a boolean");

  const rawEvidence = payload.evidence ?? [];
  if (!Array.isArray(rawEvidence)) refuse("evidence must be an array");
  if (rawEvidence.length > 8) refuse("evidence carries more than 8 references; name the decisive few");
  const evidence = rawEvidence.map((item) => {
    const value = singleLine(item, "evidence item");
    if (value.length > 300) refuse("evidence item is longer than 300 characters");
    return value;
  });
  if (evidence.length === 0 && !unverified) {
    refuse("evidence [] requires unverified: true: a claim with neither evidence nor the flag is an assertion");
  }

  const supersedes = payload.supersedes ?? null;
  if (supersedes !== null) {
    if (!Number.isInteger(supersedes)) refuse("supersedes must be an integer seq");
    if (!seqs.has(supersedes)) refuse(`supersedes names ${supersedes}, which is not in the journal`);
    const priorFork = supersededBy.get(supersedes);
    if (priorFork !== undefined) {
      refuse(`supersedes ${supersedes} was already superseded by ${priorFork}: a fork leaves two live successors`);
    }
  }

  const seq = payload.seq ?? maxSeq + 1;
  if (!Number.isInteger(seq) || seq < 1) refuse("seq must be a positive integer");
  if (seq <= maxSeq) refuse(`seq ${seq} at or below the current maximum ${maxSeq}`);

  const entry = {
    seq,
    at: writeStamp(now),
    kind,
    subject,
    ...(takesStatus ? { status } : {}),
    text,
    reason: kind === "decision" ? reason : null,
    evidence,
    supersedes,
    seat: null, // filled by the writer, below
    ...(unverified ? { unverified: true } : {}),
    ...(kind === "constraint" ? { expires_at: expiresAt } : {}),
  };
  return entry;
}

/** Provenance the agent cannot name for itself: the session it is running in
 *  and the revision it was reading. A label may be given (the seat's own name)
 *  because no process can derive it. */
function seatFrom(cwd, label) {
  const sessionFile = process.env.PI_SESSION_FILE ?? "";
  const session =
    (sessionFile ? basename(sessionFile).replace(/\.jsonl$/, "") : "") ||
    process.env.PI_SESSION_ID ||
    "unknown";
  const rev = spawnSync("git", ["-C", cwd, "rev-parse", "--short=12", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const revision = rev.status === 0 ? rev.stdout.trim() : "none";
  return { label: label || process.env.BRAID_SEAT_LABEL || "seat", session, revision };
}

function readPayload(file) {
  let raw;
  if (file) {
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      die(1, `journal-append: cannot read ${file}: ${err.message}`);
    }
  } else {
    try {
      raw = readFileSync(0, "utf8");
    } catch (err) {
      die(1, `journal-append: cannot read the payload from stdin: ${err.message}`);
    }
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    refuse(`payload is not JSON: ${err.message}`);
  }
}

/** Read the live journal for seq state. An unparseable line is an operational
 *  failure, not a skipped line: appending past a broken seq chain would make
 *  the new entry's number a guess. */
function readEntries(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  const entries = [];
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      die(
        1,
        `journal-append: ${file} line ${index + 1} is not JSON (${err.message}); ` +
          "repair the journal with check-journal.mjs before appending",
      );
    }
  });
  return entries;
}

// ── Arguments ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let cwd = process.cwd();
let project = "";
let seatLabel = "";
let payloadFile = "";
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--cwd") cwd = resolve(args[++i] ?? "");
  else if (arg === "--project") project = args[++i] ?? "";
  else if (arg === "--seat-label") seatLabel = args[++i] ?? "";
  else if (arg === "--file") payloadFile = args[++i] ?? "";
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "usage: journal-append [--cwd <dir>] [--project <slug>] [--seat-label <label>] [--file <payload>] [--dry-run]\n" +
        "one JSON entry on stdin; the written line is printed on stdout\n",
    );
    process.exit(0);
  } else die(2, `journal-append: unknown argument ${JSON.stringify(arg)}`);
}

const slug = project || projectSlugFromCwd(cwd);
const journalFile = journalFilePath(slug);
const now = new Date();
const seat = seatFrom(cwd, seatLabel);

let entry;
try {
  const payload = readPayload(payloadFile);
  entry = await withStoreLock(`${journalFile}.lock`, async () => {
    const entries = readEntries(journalFile);
    const seqs = new Set(entries.map((e) => e.seq).filter(Number.isInteger));
    const supersededBy = new Map();
    for (const prior of entries) {
      if (Number.isInteger(prior.supersedes)) supersededBy.set(prior.supersedes, prior.seq);
    }
    const maxSeq = [...seqs].reduce((max, s) => Math.max(max, s), 0);
    const built = validate(payload, { maxSeq, seqs, supersededBy, now });
    built.seat = seat;
    if (!dryRun) appendFileSync(journalFile, `${JSON.stringify(built)}\n`);
    return built;
  });
} catch (err) {
  if (err instanceof Refusal) die(2, `REFUSED: ${err.message}`);
  die(1, `journal-append: ${err?.message ?? String(err)}`);
}

process.stdout.write(`${JSON.stringify(entry)}\n`);
