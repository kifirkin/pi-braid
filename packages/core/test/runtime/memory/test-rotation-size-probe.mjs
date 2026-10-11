/**
 * Fixture: the rotation size probe reads the session file path pi exposes.
 *
 * pi's SessionManager keeps the on-disk path in the private `sessionFile`
 * field (getSessionFile() returns it); the class carries no `session` object.
 * Reading `sm.session?.filePath` therefore always yielded undefined, so
 * estimateSessionSize silently fell back to `branch.length * 2000` — the
 * 50 MB file-size check could not fire on a real session file, while a deep
 * branch could fire it with a small file.
 *
 * This fixture drives the real turn_end rotation handler with a session
 * manager shaped like the 1.0.2 instance (sessionFile + getSessionFile, no
 * `session`) and pins both directions:
 *   (a) a 52 MB branch estimate with a small REAL session file must NOT
 *       trigger the size-based rotation nudge;
 *   (b) a 51 MB REAL session file with a tiny branch must trigger it, with
 *       the file size in the reason.
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

function makeCtx(sessionFile, branch) {
  const sm = {
    // The real instance's private field; the probe must read this (or the
    // public getSessionFile()), never a `session` object.
    sessionFile,
    getSessionFile: () => sessionFile,
    getBranch: () => branch,
    getLabel: () => undefined,
    getSessionId: () => "rotation-size-fixture",
  };
  return { sessionManager: sm, model: { contextWindow: 200_000 }, cwd: "/tmp" };
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
    sendMessage(params) {
      sent.push(params?.content?.[0]?.text ?? "");
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

/** Run one turn_end through the registered rotation handler; return size notices. */
async function runRotationTurn({ fileBytes, branchLength }) {
  _resetForTests();
  resetRotationState();
  const dir = mkdtempSync(join(tmpdir(), "rotation-case-"));
  const file = makeSessionFile(dir, fileBytes);
  const pi = makeFakePi();
  const ctx = makeCtx(file, makeBranch(branchLength));
  registerRotationHandlers(pi);
  await pi._emit(
    {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: [], stopReason: "stop" },
    },
    ctx,
  );
  // The rotation nudge is a triggerTurn:true send; those defer to a macrotask.
  await new Promise((resolve) => setTimeout(resolve, 25));
  rmSync(dir, { recursive: true, force: true });
  return pi.sent.filter((text) => text.includes("Session Size Notice"));
}

await test("a deep branch with a small session file does not fake a size rotation", async () => {
  // 27_000 entries * 2000 B = ~54 MB branch estimate, over the 50 MB limit;
  // the real session file is 4 KB. The file is the truth.
  const notices = await runRotationTurn({ fileBytes: 4096, branchLength: 27_000 });
  assert.equal(
    notices.length,
    0,
    `the branch estimate must not stand in for the file size: ${notices.join(" | ")}`,
  );
});

await test("a large session file with a tiny branch fires the size rotation", async () => {
  const notices = await runRotationTurn({ fileBytes: 51 * 1024 * 1024, branchLength: 5 });
  assert.equal(notices.length, 1, `expected one size notice, got ${notices.length}`);
  assert.match(notices[0], /Session file 51MB exceeds 50MB limit/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
