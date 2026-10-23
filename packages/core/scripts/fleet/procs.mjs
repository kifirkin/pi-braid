/**
 * Process facts the fleet reads from the operating system rather than from its
 * own bookkeeping: is a pid alive, is a process group alive, how much resident
 * memory a set of pids holds.
 *
 * The journal records what the supervisor believes; these answer what the box
 * actually holds, which is the only instrument an orphan fence or a memory
 * budget can be checked with.
 */

import { execFileSync } from "node:child_process";

/** A pid that exists counts as alive; EPERM means it exists under another user. */
export function pidIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** True when any member of the process group is still running. */
export function groupIsAlive(pgid) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * RSS in mebibytes for one pid, or null when `ps` reports nothing. `ps` is the
 * instrument because it reads the kernel's number, not ours.
 */
export function rssMb(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!out) return null;
    return Math.round(Number(out) / 1024);
  } catch {
    return null;
  }
}

/**
 * The supervisor's own resident set plus every pid in it, as `{pids, totalMb}`.
 * A pid that vanished between listing and reading contributes zero rather than
 * aborting the sum, so a sample taken across a settle still prints.
 */
export function residentMb(pids) {
  const rows = [];
  let totalMb = 0;
  for (const pid of pids) {
    const mb = rssMb(pid);
    if (mb == null) continue;
    rows.push({ pid, mb });
    totalMb += mb;
  }
  return { pids: rows, totalMb };
}

/** True when `pid` is a live descendant of the current process. */
export function isOwnChild(pid) {
  if (!pidIsAlive(pid)) return false;
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Number(out) === process.pid;
  } catch {
    return false;
  }
}
