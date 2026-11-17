/**
 * The session rotation notice: what fires it, and what it offers.
 *
 * WHY THIS EXISTS:
 *   A live seat heard the rotation nudge 24 times in one 15-hour session and did
 *   nothing, which was the correct response: the notice fired on turn count
 *   alone (an accumulating number in a seat that never ends a task) and offered
 *   `finalize()`, which ends the session, as its only first action. Size and age
 *   are properties the notice can act on; turn count is a property of the seat.
 *
 * WHAT THIS PINS (the real turn_end handler, a real session file on disk):
 *   - turn count alone never fires the notice, however many turns have passed;
 *   - the turn arm fires once the file has actually grown (the co-trigger), so a
 *     long session is not silenced, only made honest;
 *   - the size arm and the age arm still fire on their own;
 *   - the notice's first offered action does not end the session, and the
 *     session-ending action is still offered as one option among others.
 *
 * Run: node test/runtime/lib/test-rotation-notice-actions.mjs
 * (built first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pin HOME (settings reads) and BRAID_HOME (log/state writes) before any dist
// module evaluates; the rotation nudge path reads both.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "rotation-notice-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
const BRAID_HOME = mkdtempSync(join(tmpdir(), "rotation-notice-braid-"));
process.env.BRAID_HOME = BRAID_HOME;
process.on("exit", () => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(BRAID_HOME, { recursive: true, force: true });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const load = (rel) => import("file://" + join(ROOT, "dist", rel));

const { registerRotationHandlers } = await load(
  "extensions/memory/context-manager/handlers/rotation.js",
);
const { getRotationState } = await load("lib/state/global-state.js");
const { _resetForTests } = await load("lib/enforcement/turn-dedup.js");
const {
  registerInjectionTracker,
  clearAllBuckets,
  _setReprimeClockForTests,
  _setAdvisoryClockForTests,
  REPRIME_COOLDOWN_MS,
} = await load("lib/utils/injection-tracker.js");
const { MAX_SESSION_AGE_MS } = await load("lib/constants/session-thresholds.js");

const TURN_LIMIT = 500;

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

function makeFakePi() {
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      const text = (params?.content ?? []).map((part) => part?.text ?? "").join("\n");
      sent.push({ text, params, options });
    },
    sendUserMessage() {},
    async emit(event, ctx) {
      const name = typeof event === "string" ? event : event.type;
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

/**
 * One rotation session over a real session file, driven for a single turn_end.
 * `turnsSinceRotation` is the state that accumulates in a live seat; `fileBytes`
 * is the size of the file on disk; `ageMs` backdates the last rotation.
 */
async function runRotation({ turnsSinceRotation, fileBytes, ageMs = 0, branchLength = 5 }) {
  _resetForTests();
  clearAllBuckets();
  _setReprimeClockForTests(Date.now() + REPRIME_COOLDOWN_MS + 1000);

  const dir = mkdtempSync(join(tmpdir(), "rotation-notice-case-"));
  const file = makeSessionFile(dir, fileBytes);
  const pi = makeFakePi();
  const ctx = {
    sessionManager: {
      sessionFile: file,
      getSessionFile: () => file,
      getBranch: () => makeBranch(branchLength),
      getLabel: () => undefined,
      getSessionId: () => "rotation-notice-fixture",
    },
    model: { contextWindow: 200_000 },
    cwd: "/tmp",
    isIdle: () => true,
  };

  Object.assign(getRotationState(), {
    lastRotationTimestamp: Date.now() - ageMs,
    turnsSinceRotation,
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

  registerRotationHandlers(pi);
  registerInjectionTracker(pi);
  await pi.emit("turn_end", ctx);
  await new Promise((resolve) => setTimeout(resolve, 25));

  _setReprimeClockForTests(null);
  _setAdvisoryClockForTests(null);
  rmSync(dir, { recursive: true, force: true });
  return pi.sent.filter((m) => m.text.includes("Session Size Notice"));
}

test("turn count alone never fires the notice, however many turns have passed", async () => {
  const notices = await runRotation({ turnsSinceRotation: TURN_LIMIT + 120, fileBytes: 4 * 1024 });
  assert.equal(
    notices.length,
    0,
    `turn count is a property of the seat, not of the file: ${notices.map((m) => m.text).join(" | ")}`,
  );
});

test("the turn arm still fires once the file has grown", async () => {
  const notices = await runRotation({
    turnsSinceRotation: TURN_LIMIT,
    fileBytes: 8 * 1024 * 1024,
  });
  assert.equal(notices.length, 1, "a long session with a grown file still gets the notice");
  assert.match(notices[0].text, /turns since last rotation/);
  assert.match(notices[0].text, /session file 8MB/, "the reason states the size it saw");
});

test("the size arm fires on size alone", async () => {
  const notices = await runRotation({ turnsSinceRotation: 1, fileBytes: 51 * 1024 * 1024 });
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Session file 51MB exceeds 50MB limit/);
});

test("the age arm fires on age alone", async () => {
  const notices = await runRotation({
    turnsSinceRotation: 1,
    fileBytes: 4 * 1024,
    ageMs: MAX_SESSION_AGE_MS + 60_000,
  });
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Session age \d+d exceeds \d+d limit/);
});

test("the notice's first offered action does not end the session", async () => {
  const notices = await runRotation({ turnsSinceRotation: 1, fileBytes: 51 * 1024 * 1024 });
  assert.equal(notices.length, 1);
  const text = notices[0].text;

  const numbered = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s/.test(line));
  assert.ok(numbered.length >= 2, "the notice offers more than one action");
  assert.doesNotMatch(
    numbered[0],
    /finalize/,
    `the first action must be one a live seat can take: ${numbered[0]}`,
  );
  assert.match(numbered[0], /context_compress/, "a live seat can archive");
  assert.ok(
    numbered.some((line) => line.includes("finalize")),
    "ending the session stays one option among others",
  );
});
