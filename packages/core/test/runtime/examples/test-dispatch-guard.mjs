/**
 * Test: the dispatch guard - a `herdr_agent prompt` runs without waiting.
 *
 * The guard is an example extension, so the fixture drives it the way pi does:
 * build a stand-in `pi`, load the extension's default factory into it, then
 * call the captured `tool_call` handler with the argument object the tool will
 * receive. In pi's loop the handler and the tool share that object (validate,
 * then the hook, then execute with the same args), so what the fixture reads
 * after the handler is what the tool would execute.
 *
 * Cases:
 * 1. A prompt with `wait` absent, or `true`, executes with `wait: false`.
 * 2. Another action of the same tool, and another tool entirely, arrive
 *    byte-identical.
 * 3. `wait: "settle"` passes through: the escape hatch.
 * 4. One line per session, and a counter that counts every rewrite; a call
 *    that already passes `wait: false` leaves no line and no record.
 * 5. Control: with no guard registered, the same call reaches the tool with no
 *    `wait` at all. That is the red run case 1 is quoted against.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..", "..", "..");
const ENTRY = join(ROOT, "examples", "dispatch-guard", "index.ts");
const NOTICE = "dispatch guard: wait forced to false on prompt";

const { default: dispatchGuard } = await import(pathToFileURL(ENTRY).href);

/** A copy of a JSON argument object, so an assertion compares against what was passed. */
const snapshot = (input) => JSON.parse(JSON.stringify(input));

/**
 * A pi stand-in. `handlers` is what the extension registered; `entries` and
 * `notices` are what it wrote; every call shares one `ctx`, so a stand-in is
 * one session.
 */
function standIn({ guard = true } = {}) {
  const handlers = new Map();
  const entries = [];
  const notices = [];

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => {};
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
  if (guard) dispatchGuard(pi);

  const ctx = {
    sessionManager: {},
    ui: { notify: (text, level) => notices.push({ text, level }) },
  };

  /**
   * One tool call as the loop runs it: the handler receives the object the tool
   * is executed with, so the returned object is what the tool would see.
   */
  async function call(toolName, input) {
    const hook = handlers.get("tool_call");
    if (hook) await hook({ type: "tool_call", toolCallId: "call", toolName, input }, ctx);
    return input;
  }

  return { handlers, entries, notices, call };
}

describe("the rewrite happens", () => {
  it("a prompt with no `wait` executes without waiting", async () => {
    const session = standIn();
    const executed = await session.call("herdr_agent", {
      action: "prompt",
      target: "reviewer",
      prompt: "read the brief",
    });
    assert.equal(executed.wait, false);
  });

  it("a prompt with `wait: true` executes without waiting", async () => {
    const session = standIn();
    const executed = await session.call("herdr_agent", {
      action: "prompt",
      target: "reviewer",
      prompt: "read the brief",
      wait: true,
    });
    assert.equal(executed.wait, false);
  });
});

describe("nothing else moves", () => {
  it("another action of the same tool arrives byte-identical", async () => {
    for (const input of [
      { action: "get", target: "reviewer" },
      { action: "read", target: "reviewer", lines: 40, format: "text" },
      { action: "list" },
    ]) {
      const before = snapshot(input);
      const session = standIn();
      assert.deepEqual(await session.call("herdr_agent", input), before);
    }
  });

  it("another tool arrives byte-identical", async () => {
    for (const [toolName, input] of [
      ["herdr_pane", { action: "read", pane: "pane-1", lines: 40 }],
      ["bash", { command: "npm test", timeout: 600000 }],
      ["read", { path: "examples/README.md", offset: 1, limit: 20 }],
    ]) {
      const before = snapshot(input);
      const session = standIn();
      assert.deepEqual(await session.call(toolName, input), before);
    }
  });
});

describe("the escape hatch", () => {
  it("`wait: settle` passes through untouched", async () => {
    const session = standIn();
    const executed = await session.call("herdr_agent", {
      action: "prompt",
      target: "reviewer",
      prompt: "read the brief",
      wait: "settle",
    });
    assert.equal(executed.wait, "settle");
    assert.deepEqual(session.notices, []);
    assert.deepEqual(session.entries, []);
  });
});

describe("the visibility", () => {
  it("one line per session, and the counter counts every rewrite", async () => {
    const session = standIn();
    await session.call("herdr_agent", { action: "prompt", target: "first", prompt: "one" });
    await session.call("herdr_agent", { action: "prompt", target: "second", prompt: "two" });

    assert.deepEqual(
      session.notices.map((notice) => notice.text),
      [NOTICE],
    );
    assert.deepEqual(
      session.entries.map((entry) => entry.customType),
      ["dispatch-guard", "dispatch-guard"],
    );
    assert.deepEqual(
      session.entries.map((entry) => entry.data.rewrites),
      [1, 2],
    );
    assert.equal(session.entries.filter((entry) => entry.data.notice === NOTICE).length, 1);
  });

  it("a new session starts its own line and its own count", async () => {
    const first = standIn();
    await first.call("herdr_agent", { action: "prompt", target: "a", prompt: "one" });
    const second = standIn();
    await second.call("herdr_agent", { action: "prompt", target: "b", prompt: "two" });

    assert.equal(second.notices.length, 1);
    assert.deepEqual(
      second.entries.map((entry) => entry.data.rewrites),
      [1],
    );
  });

  it("a call that already passes `wait: false` leaves no line and no record", async () => {
    const session = standIn();
    await session.call("herdr_agent", {
      action: "prompt",
      target: "reviewer",
      prompt: "read the brief",
      wait: false,
    });
    assert.deepEqual(session.notices, []);
    assert.deepEqual(session.entries, []);
  });
});

describe("the honest control", () => {
  it("with no guard registered the tool receives no `wait` at all", async () => {
    const control = standIn({ guard: false });
    assert.equal(control.handlers.size, 0);

    const executed = await control.call("herdr_agent", {
      action: "prompt",
      target: "reviewer",
      prompt: "read the brief",
    });

    assert.equal(executed.wait, undefined);
    assert.equal("wait" in executed, false);
    assert.deepEqual(control.notices, []);
    assert.deepEqual(control.entries, []);
  });
});
