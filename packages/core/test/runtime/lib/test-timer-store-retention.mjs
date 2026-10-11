/**
 * Regression tests: timer-store test isolation + retention cap.
 *
 * Defect A (isolation): the seven test-timer-*.mjs suites never set
 * BRAID_HOME, and getTimerFilePath resolved its path from a precomputed
 * module const that ignores BRAID_HOME — so every run wrote fixture timers
 * into the LIVE store (~/.pi/agent/braid/projects/...): 180 fixture records
 * for a session id that no real session ever owned. Fix: getTimerFilePath
 * resolves through braidDir() (the documented rule for durable-write
 * callers), and the test suites pin BRAID_HOME into a private tmpdir.
 *
 * Defect B (retention): fixture zombies in a dormant project store were
 * never pruned — foreign-record pruning runs on the sweep of the CURRENT
 * project, and no session ever runs with the test cwd. Fix: a conservative
 * retention sweep at session_start walks every project store under braidDir()
 * and drops only records meeting BOTH signals already used by the
 * foreign-zombie policy:
 *   - overdue beyond FOREIGN_TIMER_PRUNE_OVERDUE_MS (30 min): a live owner's
 *     poller services its own fires within ~1s, so 30 min means nobody is
 *     servicing it;
 *   - the owner shows no session-store life within
 *     FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS (24 h) — or has no session
 *     file at all.
 * Never touched: the current session's records (their owner file may not
 * exist yet or be stale after a long sleep — recovery depends on them),
 * unexpired records (the owner may still service them), and lines that
 * cannot be parsed (never drop what cannot be classified). A store whose
 * every record is dropped is removed (with its directory, when nothing else
 * lives there), not rewritten as a zero-byte file — the store's write path
 * owns that rule (timer/store-file.ts).
 *
 * Run: node test/runtime/lib/test-timer-store-retention.mjs
 */

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";

// Pin braid's whole persistent tree into a private tmpdir so no test writes
// the live store.
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-retention-home-"));
process.env.BRAID_HOME = BRAID_HOME;

const { getTimerFilePath, braidDir } = await import("../../../dist/lib/config/braid-paths.js");
const { sweepProjectStoresRetention, _setSessionsDirForTests } =
  await import("../../../dist/extensions/scheduling/timer/recovery.js");
const {
  FOREIGN_TIMER_PRUNE_OVERDUE_MS,
  FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS,
} = await import("../../../dist/extensions/scheduling/timer/recovery.js");

const CURRENT = "sess-retention-current";
const fakeSessionsDir = join(BRAID_HOME, "fake-sessions-store");

function storeFile(projectSlug) {
  return join(braidDir(), "projects", projectSlug, "pending-timers.jsonl");
}

function writeStore(projectSlug, lines) {
  const file = storeFile(projectSlug);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

function readStore(projectSlug) {
  const file = storeFile(projectSlug);
  let raw;
  try {
    raw = readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
  if (!raw) return [];
  return raw.split("\n").map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { __raw: l };
    }
  });
}

/** Session-store fixture with a backdatable mtime (owner-liveness evidence). */
function writeSessionFile(sessionId, ageMs) {
  const projectDir = join(fakeSessionsDir, "proj");
  mkdirSync(projectDir, { recursive: true });
  _setSessionsDirForTests(fakeSessionsDir);
  const file = join(projectDir, `ts_${sessionId}.jsonl`);
  writeFileSync(file, "{}\n", "utf-8");
  const stamp = new Date(Date.now() - ageMs);
  utimesSync(file, stamp, stamp);
  return file;
}

function overdueTimer(id, sessionId, extra = {}) {
  return {
    id,
    sessionId,
    firesAt: Date.now() - FOREIGN_TIMER_PRUNE_OVERDUE_MS * 4,
    reason: "stale cadence",
    tag: "periodic-status",
    createdAt: Date.now() - FOREIGN_TIMER_PRUNE_OVERDUE_MS * 8,
    wake: true,
    intervalMs: 1_800_000,
    count: 100000,
    fires: 5,
    ...extra,
  };
}

after(() => {
  _setSessionsDirForTests(null);
  try {
    rmSync(BRAID_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

afterEach(() => {
  _setSessionsDirForTests(null);
  try {
    rmSync(join(braidDir(), "projects"), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(fakeSessionsDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("timer store isolation (getTimerFilePath honors BRAID_HOME)", () => {
  it("REGRESSION: getTimerFilePath resolves under BRAID_HOME, never the live tree", () => {
    const file = getTimerFilePath(process.cwd());
    assert.ok(
      file.startsWith(BRAID_HOME),
      `timer store must live under the pinned BRAID_HOME (${BRAID_HOME}), got ${file}`,
    );
    assert.ok(
      !file.startsWith(join(homedir(), ".pi", "agent")),
      "sanity: must not resolve into the live tree",
    );
  });
});

describe("project-store retention sweep (session_start)", () => {
  it("drops overdue records whose owner session file is missing (fixture zombie class)", () => {
    mkdirSync(fakeSessionsDir, { recursive: true }); // sessions store exists, no files
    _setSessionsDirForTests(fakeSessionsDir);
    const file = writeStore("dormant-slug", [overdueTimer("t-zombie", "sess-ghost")]);

    sweepProjectStoresRetention(CURRENT);

    assert.equal(
      existsSync(file),
      false,
      "a store pruned to nothing is removed, not rewritten empty",
    );
    assert.equal(
      existsSync(dirname(file)),
      false,
      "and its directory (no other per-cwd state in this fixture) goes with it",
    );
  });

  it("keeps unexpired records even with a missing owner file", () => {
    mkdirSync(fakeSessionsDir, { recursive: true });
    _setSessionsDirForTests(fakeSessionsDir);
    writeStore("dormant-slug", [
      overdueTimer("t-future", "sess-ghost", { firesAt: Date.now() + 3_600_000 }),
    ]);

    sweepProjectStoresRetention(CURRENT);

    assert.deepEqual(
      readStore("dormant-slug").map((t) => t.id),
      ["t-future"],
      "unexpired record kept (the owner may still service it)",
    );
  });

  it("keeps overdue records of a freshly-active owner (live sibling, mid-tool window)", () => {
    writeSessionFile("sess-sibling-live", 0);
    writeStore("dormant-slug", [overdueTimer("t-sibling", "sess-sibling-live")]);

    sweepProjectStoresRetention(CURRENT);

    assert.deepEqual(
      readStore("dormant-slug").map((t) => t.id),
      ["t-sibling"],
      "live owner's overdue record survives",
    );
  });

  it("drops overdue records whose owner has been silent beyond the inactivity window", () => {
    writeSessionFile(
      "sess-ghost-old",
      FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS * 2,
    );
    writeStore("dormant-slug", [overdueTimer("t-stale-owner", "sess-ghost-old")]);

    sweepProjectStoresRetention(CURRENT);

    assert.equal(
      existsSync(storeFile("dormant-slug")),
      false,
      "stale-owner overdue record dropped; the emptied store removed with it",
    );
  });

  it("never touches the current session's own records (even with a missing owner file)", () => {
    mkdirSync(fakeSessionsDir, { recursive: true });
    _setSessionsDirForTests(fakeSessionsDir);
    writeStore("current-slug", [overdueTimer("t-own", CURRENT)]);

    sweepProjectStoresRetention(CURRENT);

    assert.deepEqual(
      readStore("current-slug").map((t) => t.id),
      ["t-own"],
      "current session's record is never a retention candidate",
    );
  });

  it("reaches every project store under the braid home (dormant cwds included)", () => {
    mkdirSync(fakeSessionsDir, { recursive: true });
    _setSessionsDirForTests(fakeSessionsDir);
    const currentFile = writeStore("current-slug", [overdueTimer("t-cur-zombie", "sess-ghost")]);
    const dormantFile = writeStore("other-slug", [overdueTimer("t-dorm-zombie", "sess-ghost")]);

    sweepProjectStoresRetention(CURRENT);

    assert.equal(existsSync(currentFile), false, "current project's zombies dropped too");
    assert.equal(existsSync(dormantFile), false, "dormant project's zombies dropped too");
  });

  it("malformed lines survive the sweep (never drop what cannot be classified)", () => {
    mkdirSync(fakeSessionsDir, { recursive: true });
    _setSessionsDirForTests(fakeSessionsDir);
    const file = storeFile("dormant-slug");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(overdueTimer("t-zombie", "sess-ghost"))}\n{broken json\n`,
      "utf-8",
    );

    sweepProjectStoresRetention(CURRENT);

    const raw = readFileSync(file, "utf-8");
    assert.ok(raw.includes("{broken json"), "malformed line kept verbatim");
    assert.ok(!raw.includes("t-zombie"), "classifiable zombie still dropped");
  });

  it("no projects dir: the sweep is a no-op (fresh braid home)", () => {
    _setSessionsDirForTests(null);
    assert.doesNotThrow(() => sweepProjectStoresRetention(CURRENT));
    assert.equal(readStore("dormant-slug"), null, "nothing was created");
  });
});
