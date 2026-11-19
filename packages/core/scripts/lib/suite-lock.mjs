/**
 * suite-lock.mjs - one full suite per repository at a time.
 *
 * The rule has been prose: a full suite runs alone, and nothing at the point of
 * the act checked it. Two runs of the same suite then overlap on one box, every
 * process in both slows down together, and whichever one fails does so for a
 * reason that belongs to neither of them - a file reaches a cap it would have
 * cleared, a build times out, and nothing in either log says a second suite was
 * live. This module is the check, and the test runner is where it is taken.
 *
 * The lock is a file under the repository's own runtime area: the checkout's
 * common git directory, at `pi-braid/suite.lock`. Every worktree of the
 * repository shares that file, which is the point - the two suites the rule
 * exists to separate were one worktree and one checkout of the same repository.
 * One lock per worktree would not have seen either of them. The file is not in
 * the machine's temp directory (a reboot clears it, a container gets its own)
 * and not in the home directory (that is one user's, not the repository's); it
 * is in the one directory the repository itself owns. PI_SUITE_LOCK_FILE
 * overrides the path for a caller that keeps its own tree.
 *
 * The record answers "who is this": pid, host, start time, command line,
 * working directory, git revision, and the branch when there is one. A refusal
 * is worth printing only if a reader can find and judge the holder, so all of
 * it goes in the message together with the one command that opens the file.
 *
 * Policy, and the knob that moves it:
 *   - a second run waits, prints who holds the lock, and gives up after
 *     PI_SUITE_LOCK_WAIT_MS (30s by default); PI_SUITE_LOCK_MODE=refuse makes
 *     it refuse at once. It never starts its own files beside the holder.
 *   - a refusal exits 75 (EX_TEMPFAIL): the run was asked for and not done, and
 *     running it again later is the right answer. 75 cannot be read as a red
 *     suite (1), a killed runner (130/143) or a usage error (64).
 *   - a lock whose pid is gone on this host, or whose age is past
 *     PI_SUITE_LOCK_CEILING_MS (2h by default), is reclaimed with a line naming
 *     which rule fired. A lock from another host is never reclaimed: the only
 *     instrument for another host's pid would be a network kill, and a wrong
 *     answer there costs a live suite its lock.
 *   - a lock this device cannot write - a read-only checkout, a permission it
 *     does not have - does not stop the suite: the run says what it lost and
 *     goes on. A device that can wedge every run once its own file is
 *     unwritable is a worse failure than the overlap it prevents.
 *
 * Release is unconditional by construction. The exit hook is the one path every
 * termination reaches: a normal exit, a failing file's non-zero code, a thrown
 * exception, and the runner's own SIGINT/SIGTERM handler, which exits. The hook
 * unlinks the file only while it still carries this run's token, so a lock
 * someone else has taken over is never removed by the run that lost it.
 *
 * Two runs of one process tree are not contention. The holder puts its token in
 * PI_SUITE_LOCK_TOKEN, every child it spawns inherits it, and a run that finds
 * that exact token in the lock file is inside the holder - a bench runner a
 * fixture spawned, not a second suite. The token is compared rather than
 * assumed, because a second `npm test` from a shell never carries it.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The lock file, when a caller keeps a tree this device should not resolve. */
export const FILE_ENV = "PI_SUITE_LOCK_FILE";
/** `wait` (default) or `refuse`. */
export const MODE_ENV = "PI_SUITE_LOCK_MODE";
/** How long a second run waits for the holder before refusing. */
export const WAIT_ENV = "PI_SUITE_LOCK_WAIT_MS";
/** How old a lock must be before age alone makes it reclaimable. */
export const CEILING_ENV = "PI_SUITE_LOCK_CEILING_MS";
/** The holder's proof that a child run descends from it. Set by this module. */
export const TOKEN_ENV = "PI_SUITE_LOCK_TOKEN";

/**
 * The exit code of a refusal. EX_TEMPFAIL is the standard answer for "the
 * operation could not be completed now", which is exactly what a refusal is;
 * the runner's other codes already mean other things.
 */
export const REFUSED_EXIT_CODE = 75;

/**
 * How long a second run waits by default.
 *
 * Long enough that a run finishing its last file is waited out rather than
 * refused, short enough that a queued run does not sit in front of a terminal
 * for the length of a suite it is not going to get - the bound is the
 * difference between "queue" and "hang". A caller who wants to queue for the
 * whole suite sets PI_SUITE_LOCK_WAIT_MS; a caller who wants the answer now sets
 * it to 0, or PI_SUITE_LOCK_MODE=refuse.
 */
const DEFAULT_WAIT_MS = 30_000;

/**
 * How old a lock must be before its age alone makes it reclaimable.
 *
 * The suite's own worst case is its file count divided by its width times the
 * per-file cap, which is under an hour; the ceiling sits above that with room
 * for a box running slower than the arithmetic assumes. Below the ceiling, only
 * a dead pid reclaims a lock - age is the second instrument, for the one case a
 * pid cannot settle: a pid the kernel has since reused, which looks alive
 * forever.
 */
const DEFAULT_CEILING_MS = 7_200_000;

/** How often a waiting run re-reads the lock. Short enough to feel immediate. */
const POLL_MS = 250;

/** This machine, read once: the field that decides whether a lock is ours to judge. */
const THIS_HOST = hostname();

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
 * A millisecond knob from the environment.
 *
 * A value this device cannot use is reported and the default kept, for the
 * reason the runner's own width knob states: a typo that silently became zero
 * would read as "the lock refused at once", which looks like contention rather
 * than a bad setting, and a typo that silently became unbounded would look like
 * a hang.
 */
function readMs(name, fallback, { allowZero = false } = {}) {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    const expected = allowZero ? "a number" : "a positive number";
    console.error(`ignoring ${name}="${raw}" - expected ${expected} of milliseconds`);
    return fallback;
  }
  return value;
}

/** The wait policy: `wait` unless the environment says `refuse`. */
function readMode() {
  const raw = (process.env[MODE_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "wait") return "wait";
  if (raw === "refuse") return "refuse";
  console.error(`ignoring ${MODE_ENV}="${raw}" - expected "wait" or "refuse"`);
  return "wait";
}

/** `git -C <dir> <args>` trimmed, or null: a tree without git is a tree without a lock. */
function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * A path with every symlink resolved, when it exists.
 *
 * Two runs have to name the same file to contend for it, and the same directory
 * can be spelled two ways: a checkout reached through a symlinked root (the
 * machine's temp directory is one on this platform) and the same checkout
 * reached through the path git reports. Resolving both to the physical path is
 * what makes the lock one file rather than two, which is the difference between
 * this device working and it appearing to.
 */
function physicalPath(target) {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

/**
 * The nearest ancestor of `start` that carries a `.git` entry.
 *
 * A `.git` directory is a checkout; a `.git` file is a worktree's pointer at the
 * checkout's git directory. Both are repositories from here.
 */
function repositoryRoot(start) {
  let dir = physicalPath(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where this tree's suite lock lives, and the revision a lock taken now would
 * carry.
 *
 * `file` is null when there is nothing to key a lock on - a tree copied into a
 * temporary directory for a bench, which is every fixture that copies the runner
 * - and the caller then runs unguarded with the reason. A tree with a git
 * directory but no commit still gets a lock: the revision is context in the
 * message, not the identity of the lock. `commonDir` is the directory the lock
 * sits in, named so a caller can assert the location rather than guess it.
 */
export function suiteLockTarget(root) {
  const repo = repositoryRoot(root);
  const revision = repo ? git(repo, ["rev-parse", "--short", "HEAD"]) : null;
  const branch = repo ? git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
  const override = (process.env[FILE_ENV] ?? "").trim();
  if (override !== "") {
    const named = resolve(override);
    return {
      file: join(physicalPath(dirname(named)), basename(named)),
      repo,
      commonDir: null,
      revision,
      branch,
      why: null,
    };
  }
  if (!repo) {
    return {
      file: null,
      repo: null,
      commonDir: null,
      revision,
      branch,
      why: `no repository above ${root}`,
    };
  }
  const common = git(repo, ["rev-parse", "--git-common-dir"]);
  const commonDir = common === null ? join(repo, ".git") : physicalPath(resolve(repo, common));
  return {
    file: join(commonDir, "pi-braid", "suite.lock"),
    repo,
    commonDir,
    revision,
    branch,
    why: null,
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

/**
 * What is at the lock path, as three states rather than a maybe-record.
 *
 * `gone` is the ordinary case. `held` is a record this device (or an older
 * version of it) wrote. `invalid` is somebody's file sitting at our path that
 * does not read as a lock - a foreign file, or a write this device never makes,
 * since the record is written whole before its name exists. Only age says
 * whether an unreadable file may be moved, so age is what it carries.
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
    // Not JSON. The check below refuses it as a record, and the age it carries
    // is the file's own, which is the only thing left to judge it by.
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
  const parsed = Number.isFinite(startedAtMs) ? startedAtMs : Date.parse(String(record.startedAt));
  // A start time this reader cannot parse leaves the age at zero: an age of
  // "unknown" must never be the thing that reclaims a live lock.
  return {
    state: "held",
    record,
    ageMs: Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0,
  };
}

/**
 * Why this lock may be taken from its holder, or null when it may not.
 *
 * The host is checked before either rule: a lock from another host is never
 * reclaimed, because this device has no instrument that can tell a live remote
 * process from a dead one. On this host the pid is the instrument, and that is
 * the ordinary way a lock is orphaned - a closed editor, a killed terminal, a
 * machine that slept. Age is the second instrument, for the case a pid cannot
 * settle: a reused pid looks alive forever, so a lock past the ceiling is
 * reclaimed and the printed line says which rule did it.
 */
function reclaimReason(lock, ceilingMs) {
  if (lock.state === "invalid") {
    return lock.ageMs > ceilingMs
      ? `it is unreadable (${lock.why}) and ${formatAge(lock.ageMs)} old`
      : null;
  }
  if (lock.state !== "held") return null;
  const holder = lock.record;
  if (holder.host !== THIS_HOST) return null;
  if (!pidIsAlive(holder.pid)) return `pid ${holder.pid} is gone`;
  if (lock.ageMs > ceilingMs) {
    return `it is ${formatAge(lock.ageMs)} old, past the ${formatAge(ceilingMs)} ceiling`;
  }
  return null;
}

/**
 * Take the lock if it is free, with no window in which a reader sees half of it.
 *
 * The record is written to a temporary file in the same directory and `link`
 * makes it appear whole, which fails with EEXIST when another run got there
 * first. `open(..., "wx")` would be atomic for the name and leave the content
 * empty until the write landed, and a waiter reading that moment sees an
 * unparsable lock - the state that costs a reclaim decision.
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
      // The name is either linked or refused; a leftover temp costs one file in
      // a directory this device owns, never the lock.
    }
  }
}

/**
 * Move a lock this run judged reclaimable out of the way, and say what it moved.
 *
 * The rename is the claim: only one process can move a given name aside, so two
 * waiters cannot both reclaim the same lock. What was moved is then read back,
 * because a holder can replace the file between the judgement and the move; if
 * the record is not the one judged, it is a live lock and goes back - with
 * `link`, which refuses rather than overwrites if a third run has taken the name
 * in the meantime. A rename that finds nothing means another waiter reclaimed it
 * first: the caller retries the create, and the create decides.
 */
function steal(file, judged) {
  const aside = `${file}.reclaimed-${process.pid}-${randomBytes(3).toString("hex")}`;
  try {
    renameSync(file, aside);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  const moved = readLock(aside);
  const judgedHeld = judged.state === "held";
  const sameRecord = judgedHeld
    ? moved.state === "held" && moved.record.token === judged.record.token
    : moved.state === "invalid";
  if (!sameRecord) {
    try {
      linkSync(aside, file);
    } catch {
      // A third run owns the name now, so its lock stands and this one is stale
      // precisely because it was replaced; nothing to put back.
    }
    try {
      unlinkSync(aside);
    } catch {
      // Leftover temp; the lock at the real path is what matters.
    }
    return false;
  }
  try {
    unlinkSync(aside);
  } catch {
    // Same: the reclaim already happened when the rename landed.
  }
  return true;
}

/** A fresh identity for one acquisition. Unique per process and per attempt. */
function newToken() {
  return `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/** The record this run writes when it takes the lock. */
function recordFor(target, token) {
  const startedAtMs = Date.now();
  return {
    pid: process.pid,
    host: THIS_HOST,
    // The ISO string is for the reader opening the file; the epoch milliseconds
    // beside it are for the age arithmetic, so a format change can never break
    // the one rule that depends on this field.
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    command: process.argv.join(" "),
    cwd: process.cwd(),
    revision: target.revision ?? "unknown",
    branch: target.branch && target.branch !== "HEAD" ? target.branch : null,
    token,
  };
}

/** The holder's fields as the message prints them: indented, labelled, complete. */
function holderLines(lock, target) {
  if (lock.state === "invalid") {
    return [
      `    lock      ${target.file}`,
      `    state     unreadable (${lock.why}), ${formatAge(lock.ageMs)} old`,
    ];
  }
  const record = lock.record;
  const host = record.host === THIS_HOST ? `${record.host} (this host)` : record.host;
  return [
    `    pid       ${record.pid} on ${host}, started ${formatAge(lock.ageMs)} ago`,
    `    command   ${record.command}`,
    `    cwd       ${record.cwd}`,
    `    revision  ${record.revision}${record.branch ? ` (${record.branch})` : ""}`,
    `    lock      ${target.file}`,
  ];
}

/** What a reader does next, which differs by why the lock would not be taken. */
function adviceLines(lock, target) {
  const lines = [`  Inspect it: cat ${target.file}`];
  if (lock.state === "invalid") {
    lines.push(
      "  A file that does not read as a lock is removed by hand once no suite is running: " +
        `rm ${target.file}`,
    );
    return lines;
  }
  if (lock.record.host !== THIS_HOST) {
    lines.push(
      `  It was taken on another host (this host is ${THIS_HOST}) and is never reclaimed from ` +
        "here; a person releases it.",
    );
    return lines;
  }
  lines.push(
    "  A live holder is never taken over. Queue for it with " +
      `${WAIT_ENV}=<ms>, or refuse at once with ${MODE_ENV}=refuse.`,
  );
  return lines;
}

/** The run could not be started: another suite holds the lock it needs. */
export class SuiteLockBusy extends Error {
  constructor(message, { file, waitedMs }) {
    super(message);
    this.name = "SuiteLockBusy";
    this.exitCode = REFUSED_EXIT_CODE;
    this.file = file;
    this.waitedMs = waitedMs;
  }
}

/** A result for a run that takes no lock, so every caller can call release(). */
function unguarded(why) {
  return { kind: "unguarded", file: null, why, release: () => {} };
}

/**
 * Take the suite lock for this run, wait for it, or refuse.
 *
 * Returns `{kind, file, holder, release}` where kind is `held` (this run owns
 * it), `nested` (an ancestor owns it, so this run is inside the suite rather
 * than beside it), or `unguarded` (no lock to take, and the reason is in
 * `why`). Throws SuiteLockBusy with the holder's fields when the run must not
 * start. `release` is idempotent and safe to call from anywhere, and every
 * `held` result has already registered it on the exit hook.
 */
export async function acquireSuiteLock({ root, log = () => {} }) {
  const target = suiteLockTarget(root);
  if (target.file === null) {
    log(`  Suite lock: none taken - ${target.why}; this run is not exclusive`);
    return unguarded(target.why);
  }
  const mode = readMode();
  const waitMs = mode === "refuse" ? 0 : readMs(WAIT_ENV, DEFAULT_WAIT_MS, { allowZero: true });
  const ceilingMs = readMs(CEILING_ENV, DEFAULT_CEILING_MS);
  const inherited = (process.env[TOKEN_ENV] ?? "").trim();
  const token = newToken();

  try {
    mkdirSync(dirname(target.file), { recursive: true });
  } catch (error) {
    log(
      `  Suite lock: none taken - ${dirname(target.file)} could not be created ` +
        `(${error.code ?? error.message}); this run is not exclusive`,
    );
    return unguarded(String(error.code ?? error.message));
  }

  const waitedFrom = Date.now();
  let announced = null;
  let last = null;
  try {
    for (;;) {
      if (tryCreate(target.file, recordFor(target, token))) {
        const record = readLock(target.file).record ?? recordFor(target, token);
        // Children inherit the token, which is how a bench runner one of this
        // run's own fixtures spawns knows it is inside the suite.
        process.env[TOKEN_ENV] = token;
        const release = () => {
          const current = readLock(target.file);
          if (current.state !== "held" || current.record.token !== token) return;
          try {
            unlinkSync(target.file);
          } catch {
            // A file already gone is the state release wants; anything else is
            // the ceiling's business, not the exit's.
          }
        };
        process.on("exit", release);
        log(`  Suite lock: held by this run, pid ${record.pid}, at ${target.file}`);
        return { kind: "held", file: target.file, holder: record, target, release };
      }

      const lock = readLock(target.file);
      last = lock;
      const holderToken = lock.state === "held" ? lock.record.token : null;
      if (lock.state === "held" && inherited !== "" && holderToken === inherited) {
        log(
          `  Suite lock: held by the run this one descends from (pid ${lock.record.pid}), ` +
            "so it is inside that suite, not beside it",
        );
        return { kind: "nested", file: target.file, holder: lock.record, target, release: () => {} };
      }

      const reason = reclaimReason(lock, ceilingMs);
      if (reason !== null && steal(target.file, lock)) {
        log(
          `  Suite lock: reclaimed - ${reason}; ` +
            `the run that wrote ${target.file} did not release it`,
        );
        announced = null;
        continue;
      }

      if (announced !== holderToken) {
        announced = holderToken;
        log("  Suite lock: waiting, another suite holds it");
        for (const line of holderLines(lock, target)) log(line);
        log(
          waitMs === 0
            ? "    waiting   not at all"
            : `    waiting   up to ${formatAge(waitMs)} (${WAIT_ENV})`,
        );
      }

      const waitedMs = Date.now() - waitedFrom;
      if (waitedMs >= waitMs) {
        const headline =
          lock.state === "invalid"
            ? "another run holds a lock file this device cannot read"
            : `another suite is live (pid ${lock.record.pid} on ${lock.record.host})`;
        const waited = waitedMs > 0 ? ` after waiting ${formatAge(waitedMs)}` : "";
        throw new SuiteLockBusy(
          [
            `  Suite lock: refused${waited} - ${headline}. Nothing was started.`,
            ...holderLines(lock, target),
            ...adviceLines(lock, target),
          ].join("\n"),
          { file: target.file, waitedMs },
        );
      }
      await new Promise((tick) => setTimeout(tick, Math.min(POLL_MS, waitMs - waitedMs)));
    }
  } catch (error) {
    if (error instanceof SuiteLockBusy) throw error;
    // A lock the device cannot write is a lock it cannot promise. The run must
    // still happen: the alternative is that a read-only checkout stops every
    // suite that runs in it, which is a worse failure than the overlap.
    const detail = error?.code ?? error?.message ?? String(error);
    const holder = last?.state === "held" ? last.record : null;
    log(
      `  Suite lock: none taken - ${detail} on ${target.file}` +
        `${holder ? ` (pid ${holder.pid} was there)` : ""}; this run is not exclusive`,
    );
    return unguarded(String(detail));
  }
}
