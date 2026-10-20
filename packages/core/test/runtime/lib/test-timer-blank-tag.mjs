/**
 * Fixture: a blank `tag` on `timer action=set` is absent, not a stored tag.
 *
 * A client that emits every schema key sends "" for the keys it does not use.
 * Framework validation leaves blank strings intact, and the handler's regex
 * guard was `if (tag && ...)`, so "": skipped validation and was stored as the
 * timer's tag. The list rendering then printed `[]` where the documented
 * `(untagged)` belongs, and a whitespace-only tag was worse: truthy, failing
 * `[a-zA-Z0-9_-]+`, so it was refused as an invalid tag the caller never sent.
 *
 * After the fix a blank tag is absent (`(untagged)` in the list) and a
 * whitespace tag is absent rather than an error. Controls keep the fix from
 * swallowing real tags: a real tag is validated, stored and rendered, and an
 * invalid real tag is still refused.
 *
 * Run: node test/runtime/lib/test-timer-blank-tag.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin braid's persistent tree into a private tmpdir: fixture timers must never
// write the live store (braidDir() honors BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-blank-tag-"));
process.env.BRAID_HOME = BRAID_HOME;

const timerMod = await import("../../../dist/extensions/scheduling/timer/index.js");
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

function makeFakePi() {
  const registered = {};
  return {
    registered,
    registerTool(tool) {
      registered[tool.name] = tool;
    },
    on() {},
    sendMessage() {},
  };
}

const pi = makeFakePi();
timerMod.default(pi);
const tool = pi.registered.timer;

let seq = 0;
function makeCtx() {
  const sessionId = `timer-blank-tag-${seq++}`;
  return { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionId } };
}

// The tool resolves the session id ONCE per process (module-level cache), so
// every case below shares one session and finds its own timer by id.
const ctx = makeCtx();

async function setTimer(callId, params) {
  const result = await tool.execute(callId, { action: "set", ...params }, {}, {}, ctx);
  return result.details.timer_id;
}

async function listedTimer(timerId) {
  const listed = await tool.execute(`${timerId}-list`, { action: "list" }, {}, {}, ctx);
  const timer = listed.details.timers.find((t) => t.timer_id === timerId);
  assert.ok(timer, `timer ${timerId} is in the list`);
  return { timer, text: listed.content[0].text };
}

/** Drive raw arguments through the framework's own conversion, as pi-core does before a handler runs. */
function validated(raw) {
  return validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: raw },
  );
}

after(() => {
  try {
    rmSync(BRAID_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("timer: a blank tag is absent", () => {
  it("stores no tag, so the list renders (untagged)", async () => {
    const args = await validated({
      action: "set",
      delay_seconds: 600,
      reason: "checkpoint",
      tag: "",
    });
    assert.equal(args.tag, "", "a blank string reaches the handler unchanged (tested path)");
    const set = await tool.execute("t1", args, {}, {}, ctx);

    const { timer, text } = await listedTimer(set.details.timer_id);
    assert.equal(
      timer.tag,
      "(untagged)",
      "the documented (untagged) placeholder applies to a blank tag",
    );
    assert.match(text, /\[\(untagged\)\]/);
  });

  it("treats a whitespace tag as absent, not as an invalid tag", async () => {
    const timerId = await setTimer("t3", {
      delay_seconds: 600,
      reason: "checkpoint",
      tag: "   ",
    });
    const { timer } = await listedTimer(timerId);
    assert.equal(timer.tag, "(untagged)");
  });

  it("control: a real tag is stored and rendered", async () => {
    const args = await validated({
      action: "set",
      delay_seconds: 600,
      reason: "review",
      tag: "review",
    });
    const set = await tool.execute("t5", args, {}, {}, ctx);
    const { timer, text } = await listedTimer(set.details.timer_id);
    assert.equal(timer.tag, "review");
    assert.match(text, /\[review\]/);
  });

  it("control: an invalid real tag is still refused", async () => {
    await assert.rejects(
      () =>
        tool.execute(
          "t7",
          { action: "set", delay_seconds: 600, reason: "review", tag: "not a tag!" },
          {},
          {},
          ctx,
        ),
      /Invalid tag "not a tag!"/,
    );
  });
});
