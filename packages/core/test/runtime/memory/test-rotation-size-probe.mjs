/**
 * Fixture: the rotation size probe reads the session file path pi exposes,
 * and the size notice's freshness contract (lane, stacking, age line).
 *
 * pi's SessionManager keeps the on-disk path in the private `sessionFile`
 * field (getSessionFile() returns it); the class carries no `session` object.
 * Reading `sm.session?.filePath` therefore always yielded undefined, so
 * estimateSessionSize silently fell back to `branch.length * 2000` — the
 * 50 MB file-size check could not fire on a real session file, while a deep
 * branch could fire it with a small file.
 *
 * The first two cases drive the real turn_end rotation handler with a session
 * manager shaped like the 1.0.2 instance (sessionFile + getSessionFile, no
 * `session`) and pin both directions:
 *   (a) a 52 MB branch estimate with a small REAL session file must NOT
 *       trigger the size-based rotation nudge;
 *   (b) a 51 MB REAL session file with a tiny branch must trigger it, with
 *       the file size in the reason.
 *
 * The remaining cases pin the delivery freshness of that notice against the
 * real injection funnel and registry (not a mock):
 *   (c) a streaming session parks the notice for the same turn_end flush,
 *       never the one-message-per-run-stop followUp lane; an idle session
 *       keeps the wake;
 *   (d) a second over-threshold turn_end while the first notice is still in
 *       flight emits nothing; the append events retire the first, and the
 *       next eligible turn_end emits again; the TTL frees a lost entry;
 *   (e) the emitted body carries the age rule (stamp vs last compress).
 *
 * Run: node test/runtime/memory/test-rotation-size-probe.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, openSync, ftruncateSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pin HOME (settings reads go under it) and BRAID_HOME (log/state writes)
// before any dist module evaluates; the rotation nudge path reads both.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "rotation-size-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
const BRAID_HOME = mkdtempSync(join(tmpdir(), "rotation-size-braid-"));
process.env.BRAID_HOME = BRAID_HOME;
process.on("exit", () => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(BRAID_HOME, { recursive: true, force: true });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST = join(ROOT, "dist");

const { registerRotationHandlers } = await import(
  join(DIST, "extensions/memory/context-manager/handlers/rotation.js")
);
const { getRotationState } = await import(join(DIST, "lib/state/global-state.js"));
const { _resetForTests } = await import(join(DIST, "lib/enforcement/turn-dedup.js"));
const {
  registerInjectionTracker,
  hasUnresolvedAdvisory,
  clearAllBuckets,
  _setAdvisoryClockForTests,
  _setReprimeClockForTests,
  UNRESOLVED_ADVISORY_TTL_MS,
  REPRIME_COOLDOWN_MS,
} = await import(join(DIST, "lib/utils/injection-tracker.js"));

console.log("=== rotation size probe reads the session file ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

/** A sparse file whose statSync().size is `bytes` without writing them. */
function makeSessionFile(dir, bytes) {
  const file = join(dir, "session.jsonl");
  const fd = openSync(file, "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
  return file;
}

function makeBranch(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    parentId: null,
    type: "message",
    message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: "x" }] },
  }));
}

function makeCtx(sessionFile, branch, { streaming = false } = {}) {
  const sm = {
    // The real instance's private field; the probe must read this (or the
    // public getSessionFile()), never a `session` object.
    sessionFile,
    getSessionFile: () => sessionFile,
    getBranch: () => branch,
    getLabel: () => undefined,
    getSessionId: () => "rotation-size-fixture",
  };
  return {
    sessionManager: sm,
    model: { contextWindow: 200_000 },
    cwd: "/tmp",
    isIdle: () => !streaming,
  };
}

function makeFakePi() {
  const handlers = new Map();
  const sent = [];
  const calls = [];
  return {
    sent,
    calls,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      const text = params?.content?.[0]?.text ?? "";
      sent.push(text);
      calls.push({ params, options });
    },
    sendUserMessage() {},
    async _emit(event, ctx) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) await h(event, ctx);
    },
  };
}

function resetRotationState() {
  Object.assign(getRotationState(), {
    lastRotationTimestamp: Date.now(),
    turnsSinceRotation: 0,
    rotationCount: 0,
    pendingRotation: false,
    continuationSummary: "",
    lastNudgeTimestamp: 0,
    lastNudgeTurn: 0,
    nudgeCount: 0,
    actionTaken: false,
    actionTakenAtTurn: 0,
    emergencyRotation: false,
    lastDeepBranchWhisperTimestamp: 0,
    lastDeepBranchWhisperTurn: 0,
  });
}

/**
 * One rotation session: a real registered handler set + injection tracker on
 * a fake pi, so `turnEnd()` can be driven repeatedly and `deliver()` can
 * replay pi's append events (message_start + message_end carry the message,
 * whose `details` hold the advisory correlation id).
 */
async function startRotationSession({ fileBytes, branchLength, streaming = false }) {
  _resetForTests();
  clearAllBuckets();
  resetRotationState();
  const dir = mkdtempSync(join(tmpdir(), "rotation-case-"));
  const file = makeSessionFile(dir, fileBytes);
  const pi = makeFakePi();
  const ctx = makeCtx(file, makeBranch(branchLength), { streaming });
  registerRotationHandlers(pi);
  registerInjectionTracker(pi);
  let turn = 0;
  return {
    pi,
    ctx,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    async turnEnd() {
      turn++;
      await pi._emit(
        {
          type: "turn_end",
          turnIndex: turn,
          message: { role: "assistant", content: [], stopReason: "stop" },
        },
        ctx,
      );
      // A triggerTurn send defers to a macrotask; a park send does not.
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
    async deliver(call) {
      const message = {
        role: "custom",
        customType: call.params.customType,
        content: call.params.content,
        display: call.params.display,
        details: call.params.details,
      };
      await pi._emit({ type: "message_start", message });
      await pi._emit({ type: "message_end", message });
    },
  };
}

function sizeNotices(pi) {
  return pi.calls.filter((c) => (c.params?.content?.[0]?.text ?? "").includes("Session Size Notice"));
}

/**
 * Open every emission-time window (turn/time cooldown, exact-repeat cooldown)
 * so a suppression observed by a test can only come from the advisory gate.
 */
function openRepeatWindow() {
  getRotationState().lastNudgeTimestamp = 0;
  _setReprimeClockForTests(Date.now() + REPRIME_COOLDOWN_MS + 1000);
}

/** Run one turn_end through the registered rotation handler; return size notices. */
async function runRotationTurn({ fileBytes, branchLength, streaming = false }) {
  const session = await startRotationSession({ fileBytes, branchLength, streaming });
  await session.turnEnd();
  session.cleanup();
  return sizeNotices(session.pi);
}

await test("a deep branch with a small session file does not fake a size rotation", async () => {
  // 27_000 entries * 2000 B = ~54 MB branch estimate, over the 50 MB limit;
  // the real session file is 4 KB. The file is the truth.
  const notices = await runRotationTurn({ fileBytes: 4096, branchLength: 27_000 });
  assert.equal(
    notices.length,
    0,
    `the branch estimate must not stand in for the file size: ${notices
      .map((c) => c.params.content[0].text)
      .join(" | ")}`,
  );
});

await test("a large session file with a tiny branch fires the size rotation", async () => {
  const notices = await runRotationTurn({ fileBytes: 51 * 1024 * 1024, branchLength: 5 });
  assert.equal(notices.length, 1, `expected one size notice, got ${notices.length}`);
  assert.match(notices[0].params.content[0].text, /Session file 51MB exceeds 50MB limit/);
});

await test("a streaming session parks the size notice for the same turn_end flush", async () => {
  const notices = await runRotationTurn({
    fileBytes: 51 * 1024 * 1024,
    branchLength: 5,
    streaming: true,
  });
  assert.equal(notices.length, 1, "expected one size notice");
  const { options } = notices[0];
  assert.equal(options?.deliverAs, "steer", "park lane is a steer-class send");
  assert.notEqual(options?.deliverAs, "followUp", "the run-stop lane must not carry the notice");
  assert.equal(options?.triggerTurn, false, "a streaming send must not start a competing run");
  assert.equal(
    options?.delivery,
    undefined,
    "the class is translated to pi's option shape at the funnel",
  );
});

await test("an idle session keeps the wake", async () => {
  const notices = await runRotationTurn({ fileBytes: 51 * 1024 * 1024, branchLength: 5 });
  assert.equal(notices.length, 1, "expected one size notice");
  assert.equal(notices[0].options?.triggerTurn, true, "an idle notice must still start a turn");
  assert.equal(notices[0].options?.deliverAs, undefined, "no queued lane on the idle path");
});

await test("the body carries the age rule (stamp vs last compress)", async () => {
  const notices = await runRotationTurn({ fileBytes: 51 * 1024 * 1024, branchLength: 5 });
  assert.equal(notices.length, 1, "expected one size notice");
  assert.match(
    notices[0].params.content[0].text,
    /If this stamp predates your last `context_compress`\/`finalize`, this notice is already satisfied; ignore it\./,
  );
});

await test("an in-flight notice suppresses a second emission; delivery reopens the gate", async () => {
  const session = await startRotationSession({
    fileBytes: 51 * 1024 * 1024,
    branchLength: 5,
    streaming: true,
  });
  try {
    await session.turnEnd();
    assert.equal(sizeNotices(session.pi).length, 1, "first turn_end emits the notice");
    const first = sizeNotices(session.pi)[0];
    assert.equal(typeof first.params.details?._braidId, "string", "the notice carries a registry id");
    assert.equal(hasUnresolvedAdvisory("rotation"), true, "the notice is in flight until appended");

    // Open the turn/time cooldown AND the exact-repeat window so the only
    // thing that can suppress the second emission is the unresolved gate.
    openRepeatWindow();
    await session.turnEnd();
    assert.equal(
      sizeNotices(session.pi).length,
      1,
      "a second notice must not stack behind the unresolved one",
    );

    // pi appends the parked message at the same turn_end: message_start +
    // message_end retire the registry entry.
    await session.deliver(first);
    assert.equal(hasUnresolvedAdvisory("rotation"), false, "the append events retire the notice");

    openRepeatWindow();
    await session.turnEnd();
    assert.equal(sizeNotices(session.pi).length, 2, "the next eligible turn_end emits again");
  } finally {
    _setReprimeClockForTests(null);
    session.cleanup();
  }
});

await test("an expired in-flight notice cannot wedge the emitter", async () => {
  const session = await startRotationSession({
    fileBytes: 51 * 1024 * 1024,
    branchLength: 5,
    streaming: true,
  });
  try {
    await session.turnEnd();
    assert.equal(sizeNotices(session.pi).length, 1, "first turn_end emits the notice");
    assert.equal(hasUnresolvedAdvisory("rotation"), true, "no append event: still in flight");

    // A lost append event must not wedge the emitter: past the TTL the entry
    // is pruned and the gate opens again.
    _setAdvisoryClockForTests(Date.now() + UNRESOLVED_ADVISORY_TTL_MS + 1000);
    openRepeatWindow();
    await session.turnEnd();
    assert.equal(sizeNotices(session.pi).length, 2, "the expired advisory must not hold the gate");
  } finally {
    _setAdvisoryClockForTests(null);
    _setReprimeClockForTests(null);
    session.cleanup();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
