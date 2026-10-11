/**
 * The injection tracker is branch-durable.
 *
 * Contract:
 * - every tracked injection appends a durable custom entry (`braid_injection`);
 * - reconstruction reads ONLY the active branch's entries, and two different
 *   synthetic branches reconstruct differently (the red-proof core);
 * - the per-bucket cap (MAX_INJECTIONS) applies during reconstruction;
 * - malformed payloads are skipped, never trusted;
 * - session_start rebuilds the bucket from getBranch (raw handler sets the
 *   session key; the phased Background handler rebuilds - after every
 *   MemoryState handler, including context-lifecycle's clearInjections);
 * - session_tree realigns the bucket after a pi-native checkout.
 *
 * Revert experiment (see the report): make readInjectionsFromBranch return []
 * and the branch-difference tests below go red; restore and they pass again.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const {
  registerInjectionTracker,
  trackInjection,
  getInjections,
  clearAllBuckets,
  clearInjections,
  readInjectionsFromBranch,
  INJECTION_ENTRY_TYPE,
  MAX_INJECTIONS,
} = await import("../../../dist/lib/utils/injection-tracker.js");
const { registerSessionStartHandler, SessionPhase } = await import(
  "../../../dist/lib/state/session-start-queue.js"
);

const SESSION_FILE = "/tmp/braid-durable-test-session.jsonl";

function entry(id, data, customType = INJECTION_ENTRY_TYPE) {
  return {
    type: "custom",
    customType,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    data,
  };
}

function injectionData(overrides = {}) {
  return {
    id: "inj-test-1",
    type: "enforcement",
    source: "enforcement/whisper",
    content: "body",
    timestamp: 1,
    display: true,
    steer: false,
    turn: 0,
    ...overrides,
  };
}

/** Fake pi: records listeners + durable entries, mirrors the real write path. */
function makeFakePi() {
  const listeners = new Map();
  const entries = [];
  return {
    entries,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
    appendEntry(customType, data) {
      entries.push(entry(`e${entries.length + 1}`, data, customType));
    },
    async fire(event, ctx) {
      for (const h of listeners.get(event) ?? []) await h({ type: event }, ctx);
    },
  };
}

function makeCtx(branch) {
  return {
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => SESSION_FILE,
    },
  };
}

describe("injection tracker branch durability", () => {
  beforeEach(() => {
    clearAllBuckets();
  });

  it("two synthetic branches reconstruct differently (red-proof core)", () => {
    const branchWithInjection = [entry("a1", injectionData({ content: "branch A" }))];
    const branchWithout = [];

    const withInjection = readInjectionsFromBranch(branchWithInjection);
    const without = readInjectionsFromBranch(branchWithout);

    assert.equal(withInjection.length, 1);
    assert.equal(withInjection[0].content, "branch A");
    assert.equal(without.length, 0);
    assert.notDeepEqual(withInjection, without);
  });

  it("trackInjection appends a durable braid_injection entry", () => {
    const pi = makeFakePi();
    registerInjectionTracker(pi);

    trackInjection({ type: "enforcement", source: "test/source", content: "hello" });

    assert.equal(pi.entries.length, 1, "one durable entry per tracked injection");
    assert.equal(pi.entries[0].customType, INJECTION_ENTRY_TYPE);
    assert.equal(pi.entries[0].data.source, "test/source");
    assert.equal(pi.entries[0].data.content, "hello");
  });

  it("session_start rebuilds the bucket from the branch", async () => {
    const pi = makeFakePi();
    registerInjectionTracker(pi);

    await pi.fire(
      "session_start",
      makeCtx([entry("a1", injectionData({ content: "branch A" }))]),
    );

    const got = getInjections(SESSION_FILE);
    assert.equal(got.length, 1, "the branch entry is reconstructed at session_start");
    assert.equal(got[0].content, "branch A");
  });

  it("a later session_start on a different branch replaces the bucket", async () => {
    const pi = makeFakePi();
    registerInjectionTracker(pi);

    await pi.fire("session_start", makeCtx([entry("a1", injectionData())]));
    assert.equal(getInjections(SESSION_FILE).length, 1);

    await pi.fire("session_start", makeCtx([]));
    assert.equal(
      getInjections(SESSION_FILE).length,
      0,
      "branch B never saw the injection; the bucket follows the branch",
    );
  });

  it("round trip: a tracked injection survives resume through its durable entry", async () => {
    const pi = makeFakePi();
    registerInjectionTracker(pi);

    trackInjection({ type: "memory", source: "test/roundtrip", content: "durable body" });
    assert.equal(pi.entries.length, 1);

    // Resume: the new process's branch is exactly what was appended before.
    await pi.fire("session_start", makeCtx(pi.entries));

    const got = getInjections(SESSION_FILE);
    assert.equal(got.length, 1);
    assert.equal(got[0].content, "durable body");
    assert.equal(got[0].source, "test/roundtrip");
  });

  it("cap applies during reconstruction, dropping the oldest", () => {
    const big = Array.from({ length: MAX_INJECTIONS + 25 }, (_, i) =>
      entry(`e${i}`, injectionData({ id: `inj-${i}`, content: `c${i}` })),
    );

    const out = readInjectionsFromBranch(big);

    assert.equal(out.length, MAX_INJECTIONS);
    assert.equal(out[0].content, "c25", "oldest entries beyond the cap are dropped");
    assert.equal(out.at(-1).content, `c${MAX_INJECTIONS + 24}`, "newest entry is kept");
  });

  it("malformed entries are skipped, never trusted", () => {
    const out = readInjectionsFromBranch([
      entry("x1", { nope: true }),
      { type: "message", customType: INJECTION_ENTRY_TYPE, data: injectionData() },
      entry("x2", injectionData(), "some_other_custom_type"),
      entry("x3", "not-an-object"),
      entry("x4", injectionData({ id: "valid-one" })),
    ]);

    assert.equal(out.length, 1);
    assert.equal(out[0].id, "valid-one");
  });

  it("session_tree realigns the bucket after a pi-native checkout", async () => {
    const pi = makeFakePi();
    registerInjectionTracker(pi);

    await pi.fire("session_start", makeCtx([entry("a1", injectionData())]));
    assert.equal(getInjections(SESSION_FILE).length, 1);

    await pi.fire("session_tree", makeCtx([]));
    assert.equal(
      getInjections(SESSION_FILE).length,
      0,
      "the new leaf path has no injection entries",
    );
  });

  it("the rebuild survives a MemoryState clearInjections (Background runs last)", async () => {
    const pi = makeFakePi();
    registerInjectionTracker(pi);
    // context-lifecycle clears the tracker in its MemoryState session_start
    // handler; the rebuild is registered in Background precisely so it lands
    // after that clear. Without the phase choice this test is red.
    registerSessionStartHandler(
      pi,
      SessionPhase.MemoryState,
      async () => {
        clearInjections();
      },
      "test-clear-like-context-lifecycle",
    );

    await pi.fire("session_start", makeCtx([entry("a1", injectionData())]));

    assert.equal(
      getInjections(SESSION_FILE).length,
      1,
      "the Background rebuild lands after the MemoryState clear",
    );
  });
});
