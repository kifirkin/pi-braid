#!/usr/bin/env node
/**
 * chain-lock.mjs - one full chain per machine at a time.
 *
 * A full chain is every gate and every workspace suite: `npm run ci:check`.
 * Four of them at once have taken this machine to a load average in the
 * thirties, and an earlier pile-up reached three digits. Every worker knew the
 * rule and honoured it by reading `ps aux` and hoping nothing else started in
 * the same second. That is a census of the past, never a claim on the future, so
 * two chains still begin together and both slow down; whichever one fails does
 * so for a reason that belongs to the other.
 *
 * This file is the claim. It holds one lock, machine-wide, with three verbs and
 * no wait: `acquire` answers "may I run now", `release` gives it back, `status`
 * says who has it. There is no queue and no admission order. A caller that is
 * refused decides for itself whether to do something else first, which is the
 * only decision that was ever being made by hand.
 *
 * The file is `~/.pi/agent/braid/locks/full-chain.lock`: outside every checkout,
 * because the chains being separated are run from different worktrees of the
 * same repository and from the installed package, and a lock inside a tree sees
 * only its own tree. BRAID_CHAIN_LOCK_FILE overrides the path for a caller that
 * keeps its own copy.
 *
 * The record carries the pid and the time when a chain started, not when the
 * lock was written: reclaiming is the only thing that ever needs them.
 *
 * Stale means one of three things, and each is printed with the line that fires:
 * the recorded pid is gone on this host, the file does not read as a record, or
 * the lock is older than the ceiling below. A live pid is never taken, including
 * a pid that is not this process's. A record from another host is never
 * reclaimed: the only instrument for a foreign pid would be a network kill, and
 * a wrong answer there costs a live chain its lock.
 *
 * The recorded pid is the process that will still be running while the chain
 * runs: this helper's parent, the shell that installed the exit trap. The helper
 * exits the moment the record lands, so its own pid names a process that is
 * already gone and every lock would be reclaimable one second later. `release`
 * compares against the same value, so the shell that acquired is the shell that
 * releases. The cost is stated rather than hidden: a caller that acquires in one
 * shell and releases in another is refused, because the second shell is not the
 * process holding the chain.
 *
 * Exit codes. `acquire` is 0 taken, 1 refused, and the refusal line is on
 * stderr. `release` is 0 when the file is gone at the end, 1 when a live holder
 * that is not this caller kept it. `status` is 0 always. 64 is a usage error -
 * the verb or its argument was wrong, which is neither of the two decisions.
 * A lock this device cannot write does not block the chain: the run says what it
 * lost and proceeds unlocked, because a device that can wedge every chain once
 * its own lock file is unwritable is a worse failure than the overlap.
 *
 *   node packages/core/scripts/chain-lock.mjs acquire [--reason <who and what>]
 *   node packages/core/scripts/chain-lock.mjs release
 *   node packages/core/scripts/chain-lock.mjs status
 */

import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The lock file a caller that keeps its own tree points at. */
const FILE_ENV = "BRAID_CHAIN_LOCK_FILE";

/**
 * How old a lock must be before age alone makes it reclaimable.
 *
 * The measured duration of the chain this guards is about eleven minutes, so the
 * ceiling sits an order of magnitude above any real chain and its only job is a
 * pid the kernel has since handed to somebody else. It is a constant, not a
 * knob: the number has to be far above every real chain, and a second knob is
 * another value two callers can disagree about.
 */
const CEILING_MS = 2 * 60 * 60 * 1000;

const THIS_HOST = hostname();

/** Where the lock lives unless the environment names another file. */
function lockFile() {
  const override = (process.env[FILE_ENV] ?? "").trim();
  if (override !== "") return resolve(override);
  return join(homedir(), ".pi", "agent", "braid", "locks", "full-chain.lock");
}

/** A duration as a reader counts it: 4200 -> "4s", 92000 -> "1m32s", 7200000 -> "2h". */
function formatAge(ms) {
  const value = Math.max(0, ms);
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 === 0 ? "" : `${seconds % 60}s`}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest === 0 ? "" : `${rest}m`}`;
}

/** A local clock time for a start stamp: the reader's own morning, not UTC's. */
function clockTime(ms) {
  const at = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * True when the kernel still has `pid`.
 *
 * EPERM is the kernel saying the pid exists under another user, which counts as
 * alive: the process is there whether or not this user may signal it.
 */
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * What is at the lock path, as three states rather than a maybe-record.
 *
 * `gone` is the ordinary case. `held` is a record this helper wrote. `invalid`
 * is somebody's file at our path that does not read as a record, and the only
 * thing left to judge it by is its age.
 */
function readLock(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "gone" };
    return { state: "invalid", ageMs: fileAge(file), why: error.code ?? error.message };
  }
  let record = null;
  try {
    record = JSON.parse(text);
  } catch {
    // Not JSON: the shape test below refuses it, and the age it carries is the
    // file's own, which is the only thing left to judge it by.
  }
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.pid !== "number" ||
    typeof record.host !== "string"
  ) {
    return { state: "invalid", ageMs: fileAge(file), why: "not a lock record" };
  }
  const startedAtMs = Number(record.startedAtMs);
  // A start time this reader cannot parse leaves the age at zero: an age of
  // "unknown" must never be the thing that reclaims a live lock.
  const parsed = Number.isFinite(startedAtMs) ? startedAtMs : Date.parse(String(record.startedAt));
  return {
    state: "held",
    record,
    ageMs: Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0,
  };
}

/** How long the file has existed, for a lock whose own record says nothing usable. */
function fileAge(file) {
  try {
    return Math.max(0, Date.now() - statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/** The pid of the process that holds a chain: the one that outlives this helper. */
function holderPid() {
  return process.ppid;
}

/** A field as the message prints it: quoted, so a reason with a space stays one field. */
function quoted(value) {
  return typeof value === "string" && value !== "" ? JSON.stringify(value) : "(unstated)";
}

/** The holder as one reader-facing line: who, since when, doing what, where. */
function holderLine(lock) {
  if (lock.state === "invalid") {
    return `an unreadable file (${lock.why}, ${formatAge(lock.ageMs)} old)`;
  }
  const record = lock.record;
  const host = record.host === THIS_HOST ? `${record.host}, this host` : record.host;
  const since = Number.isFinite(Number(record.startedAtMs)) ? clockTime(Number(record.startedAtMs)) : record.startedAt;
  return `pid ${record.pid} on ${host} since ${since} (${formatAge(lock.ageMs)} ago), reason ${quoted(record.reason)}, cwd ${quoted(record.cwd)}, command ${quoted(record.command)}`;
}

/**
 * Why this lock may be taken from its holder, or null when it may not.
 *
 * The host is checked before the pid: a lock from another host cannot be judged
 * from this one. On this host the pid is the instrument, and the ceiling is the
 * answer for a pid the kernel has reused - a lock nobody will release because
 * its recorded number now belongs to an unrelated process.
 */
function reclaimRule(lock) {
  if (lock.state === "invalid") return `it is not a lock record (${lock.why})`;
  if (lock.record.host !== THIS_HOST) return null;
  if (!pidIsAlive(lock.record.pid)) return `its pid ${lock.record.pid} is gone on this host`;
  if (lock.ageMs > CEILING_MS) return `it is ${formatAge(lock.ageMs)} old, past the ${formatAge(CEILING_MS)} ceiling`;
  return null;
}

/** The record this process writes when it takes the lock. */
function recordFor(reason) {
  const startedAtMs = Date.now();
  return {
    pid: holderPid(),
    host: THIS_HOST,
    // The ISO string is for the reader who opens the file; the epoch
    // milliseconds beside it are for the age arithmetic.
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null,
    command: process.argv.join(" "),
    cwd: process.cwd(),
    token: `${process.pid}-${startedAtMs}-${randomBytes(4).toString("hex")}`,
  };
}

/**
 * Write the record so the name appears only once the content is whole.
 *
 * The record goes to a temporary file in the same directory and `link` makes it
 * appear all at once, failing with EEXIST when another run got there first.
 * `open("wx")` would take the name and leave it empty until the write landed,
 * and a reader at that moment sees an unparsable lock - the one state that
 * costs a reclaim decision.
 */
function tryCreate(file, record) {
  const temp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Either linked or refused; a leftover temp costs one file in a directory
      // this instrument owns, never the lock.
    }
  }
}

/**
 * Move a file this run has judged reclaimable out of the way, and report what
 * was actually moved.
 *
 * The rename is the claim: only one process can move a given name aside, so two
 * callers cannot both reclaim the same file. `null` means the name was already
 * gone - another caller reclaimed it first, and the create decides between them.
 */
function moveAside(file) {
  const aside = `${file}.claimed-${process.pid}-${randomBytes(3).toString("hex")}`;
  try {
    renameSync(file, aside);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return { aside, lock: readLock(aside) };
}

/** Put a record back after finding it was not the one judged. */
function putBack(aside, file) {
  try {
    linkSync(aside, file);
  } catch {
    // A third caller owns the name now; its lock stands, and the record in hand
    // is stale precisely because it was replaced.
  }
  try {
    unlinkSync(aside);
  } catch {
    // The reclaim already happened when the rename landed.
  }
}

/** The judgement that identifies one record across a move: its token, or its unreadability. */
function judgementOf(lock) {
  return lock.state === "held" ? lock.record.token ?? null : `unreadable:${lock.why}`;
}

/** True when the file moved aside is still the one this run judged. */
function sameJudgement(moved, judged) {
  if (moved.state !== judged.state) return false;
  // A file that does not read as a record has no owner to protect, so two
  // unreadable reads of one path are the same judgement whatever they say.
  if (moved.state === "invalid") return true;
  return judgementOf(moved) === judgementOf(judged);
}

/**
 * Take the lock for the process that will run the chain.
 *
 * Returns `{ ok, code }`: `ok` true when this caller may run, false when a live
 * holder kept the lock. A refusal prints one line naming the holder and the
 * command that opens the file, because a refusal is worth nothing if the reader
 * cannot find who caused it.
 */
function acquire(file, reason) {
  const record = recordFor(reason);
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock = readLock(file);
    if (lock.state !== "gone") {
      const rule = reclaimRule(lock);
      if (rule === null) {
        console.error(
          `chain-lock: refused - ${file} is held by ${holderLine(lock)}; open it with: cat ${file}`,
        );
        return { ok: false, code: 1 };
      }
      const claimed = moveAside(file);
      if (claimed === null) continue;
      if (!sameJudgement(claimed.lock, lock)) {
        // The record changed between the judgement and the move: a live holder
        // replaced it, so it goes back and the next read judges the new one.
        putBack(claimed.aside, file);
        continue;
      }
      try {
        unlinkSync(claimed.aside);
      } catch {
        // The reclaim already happened when the rename landed.
      }
      console.log(`chain-lock: reclaimed ${file} - ${rule}`);
    }
    let created;
    try {
      created = tryCreate(file, record);
    } catch (error) {
      // A device that cannot write its own lock file must not wedge every chain
      // on it. The run says what it lost and goes on.
      console.error(
        `chain-lock: unguarded - ${file} cannot be written (${error.code ?? error.message}); this chain runs without the lock`,
      );
      return { ok: true, code: 0 };
    }
    if (created) {
      console.log(
        `chain-lock: acquired ${file} for pid ${record.pid} reason ${quoted(record.reason)}`,
      );
      return { ok: true, code: 0 };
    }
  }
  const latest = readLock(file);
  console.error(
    `chain-lock: refused - ${file} could not be taken in three attempts; the holder now is ${holderLine(latest)}`,
  );
  return { ok: false, code: 1 };
}

/**
 * Give the lock back.
 *
 * Only the holder removes it: the recorded pid is this caller's own or its
 * parent's, or the pid is gone. A live holder that is not this caller keeps it,
 * and so does a file that does not read as a record - a wrong delete is a
 * mutual-exclusion breach, while a wrong refusal costs one reclaim at the next
 * acquire, which reads the same file and can judge it.
 */
function release(file) {
  const lock = readLock(file);
  if (lock.state === "gone") {
    console.log(`chain-lock: free - nothing was held at ${file}`);
    return 0;
  }
  if (lock.state === "invalid") {
    console.error(
      `chain-lock: refused - ${file} is not a lock record (${lock.why}); it is left for the next acquire to reclaim`,
    );
    return 1;
  }
  if (lock.record.host !== THIS_HOST) {
    console.error(
      `chain-lock: refused - ${file} is held by ${holderLine(lock)}; a pid on another host cannot be judged from here`,
    );
    return 1;
  }
  const owner = lock.record.pid;
  const mine = owner === process.pid || owner === holderPid();
  const holderGone = !pidIsAlive(owner);
  if (!mine && !holderGone) {
    console.error(
      `chain-lock: refused - ${file} is held by ${holderLine(lock)}; only its holder or a dead pid may release it`,
    );
    return 1;
  }
  const claimed = moveAside(file);
  if (claimed === null) {
    console.log(`chain-lock: free - another caller released ${file} first`);
    return 0;
  }
  if (!sameJudgement(claimed.lock, lock)) {
    putBack(claimed.aside, file);
    console.error(
      `chain-lock: refused - ${file} changed while this release was reading it, and the record now there was put back`,
    );
    return 1;
  }
  try {
    unlinkSync(claimed.aside);
  } catch {
    // The release already happened when the rename landed.
  }
  const why = mine ? `held by this chain (pid ${owner})` : `its holder pid ${owner} is gone on this host`;
  console.log(`chain-lock: released ${file} - ${why}`);
  return 0;
}

/** Report the holder without judging or moving anything. */
function status(file) {
  const lock = readLock(file);
  if (lock.state === "gone") {
    console.log(`chain-lock: free - nothing is held at ${file}`);
    return 0;
  }
  if (lock.state === "invalid") {
    console.log(`chain-lock: unreadable - ${file} is not a lock record (${lock.why}); an acquire would reclaim it`);
    return 0;
  }
  const rule = reclaimRule(lock);
  const state = rule === null ? "held" : `stale (${rule})`;
  console.log(`chain-lock: ${state} - ${file} by ${holderLine(lock)}`);
  return 0;
}

const USAGE =
  "usage: chain-lock.mjs acquire [--reason <who and what>] | release | status";

function usageLine(problem) {
  console.error(`chain-lock: ${problem}\n${USAGE}`);
  return 64;
}

function main(argv) {
  const verb = argv[0] ?? "";
  const rest = argv.slice(1);
  let reason = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--reason") {
      reason = rest[i + 1] ?? "";
      i++;
      continue;
    }
    if (arg.startsWith("--reason=")) {
      reason = arg.slice("--reason=".length);
      continue;
    }
    return usageLine(`unknown argument "${arg}"`);
  }
  if (reason !== null && reason.trim() === "") return usageLine("--reason needs a value");
  if (verb !== "acquire" && reason !== null) return usageLine(`--reason belongs to acquire, not to ${verb}`);
  const file = lockFile();
  if (verb === "acquire") {
    if (holderPid() <= 1) {
      // The shell that would have held this chain has already exited. A record
      // naming pid 1 is a lock no rule could ever clear.
      console.error(
        `chain-lock: refused - cannot name the process that would run the chain (parent pid ${holderPid()} is gone)`,
      );
      return 1;
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch (error) {
      console.error(
        `chain-lock: unguarded - ${dirname(file)} cannot be created (${error.code ?? error.message}); this chain runs without the lock`,
      );
      return 0;
    }
    return acquire(file, reason).code;
  }
  if (verb === "release") return release(file);
  if (verb === "status") return status(file);
  return usageLine(verb === "" ? "no verb given" : `unknown verb "${verb}"`);
}

process.exitCode = main(process.argv.slice(2));
