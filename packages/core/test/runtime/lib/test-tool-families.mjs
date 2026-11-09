/**
 * Tool-reliability hints are built from declared tool families.
 *
 * The hint fires when a tool_result errors and another tool "has better
 * reliability for this task type". Two tools used to qualify merely by sharing
 * the `taskType` label, which is a phase-of-work label: `herdr_layout` (arranges
 * terminal panes) and `fetch_content` (fetches a URL) both fall through to
 * "general". So the hint recommended a pane-layout tool over a web fetcher on a
 * sample of 1 attempt against 4, and it carried `triggerTurn`, which interrupts
 * the agent's turn to deliver it.
 *
 * The contract this fixture pins:
 *   - Substitutability is declared per tool (`TOOL_FAMILIES`). An undeclared
 *     tool has no family and can never be recommended for another tool.
 *   - No suggestion unless both sides carry at least `MIN_ATTEMPTS` (5) and the
 *     alternative clears the failing tool by `MIN_GAP` (0.2).
 *   - The delivered sentence prints BOTH counts, the task type the counts are
 *     grouped by, and the family that makes the comparison admissible.
 *   - The hint does not start a turn: it parks for the next one.
 *   - One hint per family per `HINT_COOLDOWN_TURNS` turns.
 *
 * The emitter is driven through the real extension: `threeMemoryStoresExtension`
 * registers the `tool_result` and `turn_end` handlers the production loop calls.
 *
 * Run: node test/runtime/lib/test-tool-families.mjs
 * (built first: npm run build)
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

const {
  familyOf,
  suggestAlternative,
  formatSuggestion,
  createFamilyHintGate,
  noteTurn,
  allowFamilyHint,
  HINT_COOLDOWN_TURNS,
  MIN_ATTEMPTS,
} = await import("../../../dist/lib/tools/tool-families.js");
const { default: threeMemoryStoresExtension, getState, recordToolCall } = await import(
  "../../../dist/extensions/memory/three-memory-stores/index.js"
);
const { clearAllBuckets, _setReprimeClockForTests, REPRIME_COOLDOWN_MS } = await import(
  "../../../dist/lib/utils/injection-tracker.js"
);
const { _resetForTests, beginTurn } = await import("../../../dist/lib/enforcement/turn-dedup.js");

/** One statistic as the extension stores it. */
function stat(tool, taskType, successes, attempts) {
  return { tool, taskType, attempts, successes };
}

function analyticsSends(pi) {
  return pi.sent.filter((s) => s.params?.customType === "analytics");
}

function bodyOf(send) {
  return (send?.params?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function makePi() {
  return {
    handlers: new Map(),
    sent: [],
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    sendMessage(params, options) {
      this.sent.push({ params, options });
    },
    sendUserMessage() {},
    registerTool() {},
  };
}

function freshWhisperState() {
  clearAllBuckets();
  _resetForTests();
  // The production loop opens a turn on the `input` event; the flood cap and
  // the per-source budget are turn-scoped, so a fixture that never opens one
  // exhausts them and reads the emptiness as silence from the code under test.
  beginTurn();
}

/** A waking send is deferred to setTimeout(0); drain it so counts are honest. */
function flushDeferred() {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

const CWD = "/tmp/projects/agents/pi-braid";

/**
 * Run the real extension over a seeded statistic set. `seed` fills the state the
 * session would have accumulated; `events` are the tool_results to dispatch.
 */
async function drive(id, seed, events) {
  freshWhisperState();
  const pi = makePi();
  threeMemoryStoresExtension(pi);
  const ctx = {
    cwd: CWD,
    sessionManager: {
      getSessionFile: () => `tool-families-${id}.jsonl`,
      getSessionId: () => `tool-families-${id}`,
    },
  };
  const state = getState(ctx);
  state.currentSessionId = ctx.sessionManager.getSessionId();
  seed(state);
  const handler = pi.handlers.get("tool_result");
  assert.ok(handler, "three-memory-stores must register a tool_result handler");
  const turnHandler = pi.handlers.get("turn_end");
  assert.ok(turnHandler, "three-memory-stores must register a turn_end handler");
  const fire = async (event) => {
    await handler(event, ctx);
    await flushDeferred();
  };
  for (const event of events) await fire(event);
  return { pi, ctx, state, handler, turnHandler, fire };
}

/** Advance the session's turn clock without letting recall run. */
async function completeTurn(harness, count = 1) {
  for (let i = 0; i < count; i++) {
    harness.state.currentSessionTools = [];
    await harness.turnHandler({}, harness.ctx);
    beginTurn();
  }
}

// ── The family decision ─────────────────────────────────────────────────────

describe("tool families", () => {
  it("names no substitute across families, whatever the counts say", () => {
    // The pair from the defect: a 1-of-4 web fetcher and a 1-of-1 pane tool,
    // both labelled "general".
    const reported = [
      stat("fetch_content", "general", 1, 4),
      stat("herdr_layout", "general", 1, 1),
    ];
    assert.equal(
      suggestAlternative({ stats: reported, tool: "fetch_content", taskType: "general" }),
      null,
      "a pane tool must not be named as a substitute for a web fetcher",
    );
    assert.equal(
      suggestAlternative({ stats: reported, tool: "herdr_layout", taskType: "general" }),
      null,
      "the refusal is symmetric",
    );

    // Same verdict on samples a thousand attempts deep: the family is the
    // reason, not the floor.
    const deep = [
      stat("fetch_content", "general", 0, 1000),
      stat("herdr_layout", "general", 1000, 1000),
    ];
    assert.equal(
      suggestAlternative({ stats: deep, tool: "fetch_content", taskType: "general" }),
      null,
    );
    assert.notEqual(familyOf("herdr_layout"), familyOf("fetch_content"));
  });

  it("refuses a sample under the floor on either side", () => {
    // The failing tool is thin.
    assert.equal(
      suggestAlternative({
        stats: [stat("read", "file_edit", 5, 5), stat("edit", "file_edit", 0, 4)],
        tool: "edit",
        taskType: "file_edit",
      }),
      null,
      `a tool with fewer than ${MIN_ATTEMPTS} attempts has no rate to report`,
    );
    // The alternative is thin, however wide the gap.
    assert.equal(
      suggestAlternative({
        stats: [stat("read", "file_edit", 1, 1), stat("edit", "file_edit", 1, 6)],
        tool: "edit",
        taskType: "file_edit",
      }),
      null,
      "the alternative needs its own sample before it can be named",
    );
    // Exactly at the floor satisfies it: the rule is a floor, not a bigger number.
    const atFloor = suggestAlternative({
      stats: [stat("read", "file_edit", 5, 5), stat("edit", "file_edit", 0, 5)],
      tool: "edit",
      taskType: "file_edit",
    });
    assert.ok(atFloor, `${MIN_ATTEMPTS} attempts on both sides must be enough`);
    assert.deepEqual(atFloor.sample, { attempts: 5, successes: 0 });
    assert.deepEqual(atFloor.alternatives, { attempts: 5, successes: 5 });
  });

  it("suggests inside a family, and the sentence carries both counts", () => {
    const suggestion = suggestAlternative({
      stats: [
        stat("herdr_layout", "terminal", 1, 6),
        stat("herdr_pane", "terminal", 7, 9),
        stat("bash", "terminal", 1, 9),
      ],
      tool: "herdr_layout",
      taskType: "terminal",
    });
    assert.ok(suggestion, "a same-family alternative with a wide gap must be suggested");
    assert.equal(suggestion.alternative, "herdr_pane");
    assert.equal(suggestion.family, "terminal");
    assert.equal(suggestion.taskType, "terminal");
    assert.deepEqual(suggestion.sample, { attempts: 6, successes: 1 });
    assert.deepEqual(suggestion.alternatives, { attempts: 9, successes: 7 });
    assert.equal(suggestion.current, 1 / 6);
    assert.equal(suggestion.better, 7 / 9);

    const sentence = formatSuggestion(suggestion);
    assert.match(sentence, /herdr_pane succeeded 7 of 9/, "the alternative's sample is printed");
    assert.match(sentence, /herdr_layout succeeded 1 of 6/, "the failing tool's sample is printed");
    assert.match(sentence, /"terminal"/, "the task type the counts are grouped by is named");
    assert.match(sentence, /tool family: terminal/, "the family that admits the comparison is named");
    assert.doesNotMatch(sentence, /%/, "a percentage without its counts is what made the old hint unreadable");
  });

  it("holds the gap at exactly the declared margin", () => {
    // 3/5 - 2/5 is exactly 0.2; as floats it is 0.19999999999999996, so a
    // float-subtraction implementation refuses a comparison the rule allows.
    assert.ok(
      suggestAlternative({
        stats: [stat("write", "file_edit", 3, 5), stat("edit", "file_edit", 2, 5)],
        tool: "edit",
        taskType: "file_edit",
      }),
      "a gap of exactly 0.2 must qualify",
    );
    // 59/100 - 2/5 is 0.19: under the margin at a large sample size.
    assert.equal(
      suggestAlternative({
        stats: [stat("write", "file_edit", 59, 100), stat("edit", "file_edit", 2, 5)],
        tool: "edit",
        taskType: "file_edit",
      }),
      null,
      "a gap under 0.2 must not qualify",
    );
  });

  it("refuses a tool that no family declares", () => {
    assert.equal(familyOf("some_future_tool"), null);
    assert.equal(familyOf("toString"), null, "prototype names are not families");
    assert.equal(
      suggestAlternative({
        stats: [stat("read", "file_edit", 100, 100), stat("some_future_tool", "file_edit", 0, 100)],
        tool: "some_future_tool",
        taskType: "file_edit",
      }),
      null,
      "an undeclared tool is comparable with nothing",
    );
    // A declared family with one member has no substitute.
    assert.equal(
      suggestAlternative({
        stats: [stat("herdr_layout", "terminal", 100, 100), stat("herdr_agent", "terminal", 0, 100)],
        tool: "herdr_agent",
        taskType: "terminal",
      }),
      null,
    );
  });

  it("names the same alternative for the same statistics", () => {
    const pair = [stat("read", "file_edit", 5, 5), stat("grep", "file_edit", 5, 5)];
    const forward = suggestAlternative({
      stats: [...pair, stat("edit", "file_edit", 0, 6)],
      tool: "edit",
      taskType: "file_edit",
    });
    const reversed = suggestAlternative({
      stats: [...pair].reverse().concat([stat("edit", "file_edit", 0, 6)]),
      tool: "edit",
      taskType: "file_edit",
    });
    assert.equal(forward?.alternative, "grep", "equal rates break by tool name");
    assert.equal(reversed?.alternative, forward?.alternative, "iteration order cannot change the pick");
  });

  it("paces one hint per family on a turn clock", () => {
    const gate = createFamilyHintGate();
    assert.equal(allowFamilyHint(gate, "files"), true, "the first hint for a family is allowed");
    assert.equal(allowFamilyHint(gate, "files"), false, "a second hint in the same turn is not");
    assert.equal(allowFamilyHint(gate, "terminal"), true, "another family has its own budget");
    noteTurn(gate);
    assert.equal(allowFamilyHint(gate, "files"), false, "one turn later it is still cooling down");
    noteTurn(gate);
    noteTurn(gate);
    noteTurn(gate);
    noteTurn(gate);
    noteTurn(gate);
    noteTurn(gate);
    noteTurn(gate);
    noteTurn(gate);
    assert.equal(gate.turn, 9);
    assert.equal(allowFamilyHint(gate, "files"), false, `${HINT_COOLDOWN_TURNS} turns have not elapsed`);
    noteTurn(gate);
    assert.equal(allowFamilyHint(gate, "files"), true, `a hint is due again after ${HINT_COOLDOWN_TURNS} turns`);
  });
});

// ── The emitter ─────────────────────────────────────────────────────────────

describe("reliability hint emitter", () => {
  it("stays silent on the cross-family comparison from the defect", async () => {
    const harness = await drive(
      "cross-family",
      (state) => {
        // The reported pair, plus unrelated tools so the session looks like a
        // real one (the old code required more than three tracked tools).
        recordToolCall(state, "fetch_content", "general", true);
        recordToolCall(state, "fetch_content", "general", false);
        recordToolCall(state, "fetch_content", "general", false);
        recordToolCall(state, "fetch_content", "general", false);
        recordToolCall(state, "herdr_layout", "general", true);
        for (let i = 0; i < 3; i++) recordToolCall(state, "read", "file_read", true);
        for (let i = 0; i < 3; i++) recordToolCall(state, "grep", "search", true);
      },
      [{ toolName: "fetch_content", isError: true }],
    );

    assert.equal(
      analyticsSends(harness.pi).length,
      0,
      "no hint may compare a web fetcher with a pane-layout tool",
    );
    // The event was processed: the silence is a decision, not a dropped event.
    const failing = harness.state.toolStats.get("fetch_content:general");
    assert.equal(failing.attempts, 5, "the failing call must be recorded");
    assert.equal(failing.successes, 1);
  });

  it("stays silent when the alternative's sample is thin", async () => {
    const harness = await drive(
      "thin-sample",
      (state) => {
        recordToolCall(state, "find", "search", true); // 1 of 1
        for (let i = 0; i < 4; i++) recordToolCall(state, "grep", "search", false);
      },
      [{ toolName: "grep", isError: true }],
    );

    assert.equal(
      analyticsSends(harness.pi).length,
      0,
      "a 1-of-1 alternative is not evidence for switching",
    );
    assert.equal(harness.state.toolStats.get("grep:search").attempts, 5);
  });

  it("delivers one hint with both counts, parked for the next turn", async () => {
    const harness = await drive(
      "healthy-pair",
      (state) => {
        // `inferTaskType` labels both search tools "search", so this pair is a
        // comparison production can actually reach.
        for (let i = 0; i < 5; i++) recordToolCall(state, "grep", "search", false);
        for (let i = 0; i < 5; i++) recordToolCall(state, "find", "search", true);
      },
      [{ toolName: "grep", isError: true }],
    );

    const sends = analyticsSends(harness.pi);
    assert.equal(sends.length, 1, "a same-family pair with a real gap must produce one hint");
    const [send] = sends;
    assert.equal(send.options?.triggerTurn, false, "the hint must not start a turn");
    assert.equal(send.options?.deliverAs, "steer", "the hint still rides the next steer");
    const body = bodyOf(send);
    assert.match(body, /find succeeded 5 of 5 on "search"/);
    assert.match(body, /grep succeeded 0 of 6/);
    assert.match(body, /tool family: files/);
    assert.match(body, /^\[braid-whisper - analytics @ /, "the envelope family matches the body");
  });

  it("paces the hint per family across turns", async () => {
    const harness = await drive(
      "pacing",
      (state) => {
        for (let i = 0; i < 5; i++) recordToolCall(state, "grep", "search", false);
        for (let i = 0; i < 5; i++) recordToolCall(state, "find", "search", true);
        for (let i = 0; i < 5; i++) recordToolCall(state, "herdr_layout", "general", false);
        for (let i = 0; i < 5; i++) recordToolCall(state, "herdr_pane", "general", true);
      },
      [{ toolName: "grep", isError: true }],
    );
    assert.equal(analyticsSends(harness.pi).length, 1, "the first failure earns the hint");

    // A second family in the same turn is not blocked by the first family's
    // budget: the limit is per family, not one hint per session.
    await harness.fire({ toolName: "herdr_layout", isError: true });
    assert.equal(analyticsSends(harness.pi).length, 2, "another family has its own budget");

    // The same family again, still inside its cooldown: no third hint.
    await harness.fire({ toolName: "grep", isError: true });
    assert.equal(
      analyticsSends(harness.pi).length,
      2,
      "the same family must not be re-hinted inside its cooldown",
    );

    // Ten completed turns later the family is due again. The new attempt makes
    // the sentence differ only in its counts, and the funnel's repeat check
    // collapses digit runs, so the clock has to move past that window too.
    await completeTurn(harness, HINT_COOLDOWN_TURNS);
    _setReprimeClockForTests(Date.now() + REPRIME_COOLDOWN_MS + 1000);
    try {
      await harness.fire({ toolName: "grep", isError: true });
    } finally {
      _setReprimeClockForTests(null);
    }
    const sends = analyticsSends(harness.pi);
    assert.equal(sends.length, 3, "the family earns a new hint after the cooldown");
    assert.match(bodyOf(sends[2]), /grep succeeded 0 of 8/, "the new sample is the one printed");
  });
});
