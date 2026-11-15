/**
 * Test: adherence DIGEST — one owner message per window, suppression counted,
 * and the ladder left exactly as it was.
 *
 * The meter used to send one owner message per crossing over the TG signal
 * seam. A session whose rule kept repeating therefore produced a stream of
 * near-identical messages (the owner counted twelve in one night). The
 * routing change folds crossings into at most one digest per hour; the ladder
 * (`planEscalation`, the 3/6/15 milestones, the per-session budget) is
 * untouched, and a rung is still spent only when the owner channel accepted
 * the message that reported it.
 *
 * Fixtures:
 *   1. two crossings in one pass → ONE digest carrying the suppressed count;
 *   2. a crossing inside the window is buffered (no message, rung unspent) and
 *      reports after the window;
 *   3. a session that does not own the owner channel sends nothing;
 *   4. a refused delivery spends nothing and retries on the next pass;
 *   5. below-threshold rules never become pending (detection unchanged);
 *   6. the digest body reads as a sentence, and the three shapes it can take
 *      (one rule, four folded rules, a rule that needs escaping) are frozen so
 *      the Telegram-side fixture validates the same bytes the owner receives.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The frozen digest bodies. They live in the telegram package beside the gate
 * that has to accept them, because that package cannot import core and the
 * body is the only thing the two sides share. This fixture is the producer
 * side: it asserts the renderer emits exactly these lines.
 */
const FROZEN = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "..",
      "telegram",
      "test",
      "fixtures",
      "adherence-digest-bodies.json",
    ),
    "utf8",
  ),
);

console.log("=== adherence digest ===\n");

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

const meter = await import(join(ROOT, "dist/lib/enforcement/adherence-meter.js"));
const wiring = await import(
  join(ROOT, "dist/extensions/enforcement/handlers/register-adherence-meter.js")
);

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

// ── Fixture builders ────────────────────────────────────────────────────────

function entry(id, parentId, content, source = "enforcement/whisper") {
  return {
    type: "custom",
    customType: "braid_injection",
    data: {
      id: `inj-${id}`,
      type: "enforcement",
      source,
      content,
      timestamp: 1000,
      display: true,
      steer: false,
      turn: 0,
    },
    id,
    parentId,
  };
}

/**
 * Append `n` deliveries of one whisper to a linear branch (each entry's parent
 * is the previous entry), which is the shape `activeBranchEntries` walks.
 */
function append(branch, prefix, n, content, source) {
  let parent = branch.length > 0 ? branch[branch.length - 1].id : null;
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    branch.push(entry(id, parent, content, source));
    parent = id;
  }
  return branch;
}

function ctxFor(branch, sessionId = "digest-s1") {
  return {
    cwd: "/tmp/proj",
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => null,
      getSessionId: () => sessionId,
    },
  };
}

function senderSpy() {
  const sent = [];
  return {
    sent,
    factory: () => (text, opts) => {
      sent.push({ text, opts });
      return true;
    },
  };
}

const ALPHA = "[braid-whisper - enforcement @ 10:00 MSK]\nAlpha rule fired at 25/30";
const BETA = "[braid-whisper - rule-b @ 10:01 MSK]\nBeta rule fired";
const CHARLIE = "[braid-whisper - rule-c @ 10:02 MSK]\nCharlie rule fired";
const DELTA = "[braid-whisper - rule-d @ 10:03 MSK]\nDelta rule fired";

/**
 * Assert a rendered body against its frozen lines: the subject, the sentence,
 * and one short stamp whose text is the machine's owner zone rather than part
 * of the freeze.
 */
function assertFrozenBody(body, name) {
  const expected = FROZEN.bodies[name];
  assert.ok(expected, `no frozen body named ${name}`);
  const lines = body.split("\n");
  assert.equal(lines.length, 3, `${name}: subject, one sentence, one stamp`);
  assert.equal(lines[0], expected[0], `${name}: subject line`);
  assert.equal(lines[1], expected[1], `${name}: the sentence`);
  assert.match(
    lines[2],
    /^at \d{2}:\d{2} \S+ \(UTC[+-]\d+\)$/,
    `${name}: one short time stamp, saw "${lines[2]}"`,
  );
  return lines;
}

// ── 1. Two crossings in one pass → one digest ───────────────────────────────

await test("fixture 1: two crossings in one pass produce ONE digest with the suppressed count", async () => {
  const branch = append([], "a", 4, ALPHA);
  append(branch, "b", 4, BETA, "rule-b");
  const ctx = ctxFor(branch);
  const spy = senderSpy();
  let clock = T0;
  const deps = { sender: spy.factory, now: () => clock };

  const r = await wiring.checkAdherence(ctx, deps);
  assert.equal(spy.sent.length, 1, "one owner message, not one per crossing");
  assert.equal(r.fired.length, 2, "both crossings committed by the digest");

  const { text, opts } = spy.sent[0];
  assert.equal(opts.parseMode, "HTML", "digest ships as HTML (bold subject)");
  assert.equal(opts.source, "adherence-digest");
  assert.equal(opts.suppressed, 1, "the second crossing is the suppressed count");
  assert.equal(
    text.split("\n")[0],
    "<b>Adherence · rung 3 · two rules</b>",
    "bold subject names the rung and what the message is about",
  );
  assert.equal(
    text.split("\n")[1],
    `Two crossings, from two rules, are reported together in this message. ` +
      `The rule "Beta rule fired" (rule-b) has repeated 3 times across 4 deliveries.`,
    "one sentence carries the folding count and the counts",
  );
  for (const field of ["deliveries ", "repeats ", "suppressed ", "session ", "where "]) {
    assert.equal(
      text.includes(`\n${field}`),
      false,
      `no labelled field survives (${field.trim()})`,
    );
  }

  // Nothing else fires while the window is closed, even though the branch
  // still carries both crossings above their milestones.
  clock = T0 + 30_000;
  const r2 = await wiring.checkAdherence(ctx, deps);
  assert.equal(r2.fired.length, 0, "the same pass does not re-report");
  assert.equal(spy.sent.length, 1);
});

// ── 2. The window: buffer, then report ─────────────────────────────────────

await test("fixture 2: a crossing inside the window is buffered, then reports after it", async () => {
  const branch = append([], "a2", 4, ALPHA);
  append(branch, "b2", 4, BETA, "rule-b");
  const ctx = ctxFor(branch, "digest-window");
  const spy = senderSpy();
  let clock = T0;
  const deps = { sender: spy.factory, now: () => clock };

  await wiring.checkAdherence(ctx, deps);
  assert.equal(spy.sent.length, 1, "first digest");

  // Three more Alpha deliveries → 6 repeats → rung 6, sixty seconds later.
  append(branch, "a2b", 3, ALPHA);
  clock = T0 + 60_000;
  const r2 = await wiring.checkAdherence(ctx, deps);
  assert.equal(r2.fired.length, 0, "nothing fires inside the window");
  assert.equal(spy.sent.length, 1, "no second message inside the hour");

  // After the window the buffered crossing reports.
  clock = T0 + HOUR + 1_000;
  const r3 = await wiring.checkAdherence(ctx, deps);
  assert.equal(spy.sent.length, 2, "the buffered crossing reports after the hour");
  assert.equal(r3.fired.length, 1);
  assert.match(spy.sent[1].text, /rung 6/);
  assert.equal(
    spy.sent[1].text.split("\n").length,
    3,
    "a single crossing has no folding sentence to state",
  );
  assert.equal(
    spy.sent[1].text.includes("crossings"),
    false,
    "one crossing is not called a fold",
  );
});

// ── 3. Ownership: a non-owner session never messages the owner ──────────────

await test("fixture 3: an escalation from a non-owner session produces no owner message", async () => {
  const branch = append([], "n", 4, ALPHA);
  const ctx = ctxFor(branch, "digest-worker");
  const spy = senderSpy();
  const r = await wiring.checkAdherence(ctx, {
    sender: spy.factory,
    now: () => T0,
    ownerSession: () => false,
  });
  assert.equal(spy.sent.length, 0, "no owner message from a non-owner session");
  assert.equal(r.fired.length, 0, "nothing fired");
});

// ── 4. A refused delivery spends nothing ───────────────────────────────────

await test("fixture 4: a refused digest leaves the rung unspent and retries", async () => {
  const branch = append([], "f", 4, ALPHA);
  const ctx = ctxFor(branch, "digest-retry");
  let clock = T0;
  const sent = [];
  let accept = false;
  const sender = (text) => {
    if (!accept) return false;
    sent.push(text);
    return true;
  };

  const r1 = await wiring.checkAdherence(ctx, {
    sender: () => sender,
    now: () => clock,
  });
  assert.equal(r1.fired.length, 0, "a refused delivery fires nothing");
  assert.equal(sent.length, 0);

  accept = true;
  clock = T0 + 5_000;
  const r2 = await wiring.checkAdherence(ctx, {
    sender: () => sender,
    now: () => clock,
  });
  assert.equal(sent.length, 1, "the same crossing is retried");
  assert.equal(r2.fired.length, 1, "the rung is spent only after acceptance");
});

// ── 5. Detection unchanged ────────────────────────────────────────────────

await test("fixture 5: a rule below the milestone never becomes pending (detection unchanged)", async () => {
  const branch = append([], "u", 2, ALPHA); // 1 repeat: below K = 3
  const ctx = ctxFor(branch, "digest-below");
  const spy = senderSpy();
  const r = await wiring.checkAdherence(ctx, {
    sender: spy.factory,
    now: () => T0,
  });
  assert.equal(spy.sent.length, 0);
  assert.equal(r.fired.length, 0);

  // The ladder itself is untouched: milestones and budget still gate.
  const state = meter.createEscalationState();
  assert.equal(meter.planEscalation(state, "r", 2).fire, false);
  assert.equal(meter.planEscalation(state, "r", 3).fire, true);
  assert.equal(meter.ADHERENCE_ESCALATION_MILESTONES.join(","), "3,6,15");
  assert.equal(meter.ADHERENCE_ESCALATION_BUDGET_PER_SESSION, 12);
});

// ── 6. The body is a sentence ────────────────────────────────────────────

await test("fixture 6: one rule renders a subject, one sentence and one stamp", async () => {
  const branch = append([], "o", 4, ALPHA);
  const ctx = ctxFor(branch, "digest-one");
  const spy = senderSpy();
  await wiring.checkAdherence(ctx, { sender: spy.factory, now: () => T0 });
  assert.equal(spy.sent.length, 1);
  const { text, opts } = spy.sent[0];
  assert.equal(opts.suppressed, 0);

  const lines = assertFrozenBody(text, "one-rule");
  assert.ok(
    text.length <= 280,
    `one rule fits the plain cap (${text.length} chars)`,
  );
  // The rule is the subject of the sentence, quoted in full, with the internal
  // source token after it in parentheses rather than in front of it.
  assert.equal(
    lines[1].startsWith(`The rule "Alpha rule fired at #/#" (enforcement/whisper) `),
    true,
    `rule first, source after: ${lines[1]}`,
  );
});

await test("fixture 7: four folded rules are named in the subject and counted in one sentence", async () => {
  const branch = append([], "p", 4, ALPHA); // 3 repeats → rung 3
  append(branch, "q", 7, BETA, "rule-b"); // 6 repeats → rung 6
  append(branch, "r", 16, CHARLIE, "rule-c"); // 15 repeats → rung 15
  append(branch, "s", 4, DELTA, "rule-d"); // 3 repeats → rung 3
  const ctx = ctxFor(branch, "digest-four");
  const spy = senderSpy();
  await wiring.checkAdherence(ctx, { sender: spy.factory, now: () => T0 });
  assert.equal(spy.sent.length, 1, "four crossings, still ONE message");
  const { text, opts } = spy.sent[0];
  assert.equal(opts.suppressed, 3, "three of the four are the folded count");

  const lines = assertFrozenBody(text, "four-folded");
  assert.equal(
    lines[0],
    "<b>Adherence · rung 3 · four rules</b>",
    "the subject names the rung and how many rules are in it",
  );
  assert.equal(
    lines[1].startsWith(
      "Four crossings, from four rules, are reported together in this message.",
    ),
    true,
    "a digest that folded several says so, and names how many",
  );
  // The ladder advances one rung per pass, so four rules crossing together all
  // sit on rung 3 and the rung says nothing about severity; the repeat counts do.
  assert.equal(
    lines[1].includes(
      'The rule "Charlie rule fired" (rule-c) has repeated 15 times across 16 deliveries.',
    ),
    true,
    "the most-repeated rule is quoted, with its own counts",
  );
});

await test("fixture 8: a long rule is quoted in full; past the plain cap the body carries the format", async () => {
  const longRule = "Very long rule text ".repeat(20);
  const branch = append(
    [],
    "l",
    4,
    `[braid-whisper - enforcement @ 10:00 MSK]\n${longRule}`,
  );
  const ctx = ctxFor(branch, "digest-long");
  const spy = senderSpy();
  await wiring.checkAdherence(ctx, { sender: spy.factory, now: () => T0 });
  assert.equal(spy.sent.length, 1);
  const { text, opts } = spy.sent[0];

  // The rule is never clipped into a fragment: a fragment of a rule tells the
  // owner nothing, and the outbound gate carries a formatted body rather than
  // asking a sender to pre-chew its subject.
  const normalized = longRule.replace(/\s+/g, " ").trim();
  assert.equal(
    text.includes(`"${normalized}"`),
    true,
    "the whole rule is quoted",
  );
  assert.equal(text.includes("..."), false, "nothing is shortened");

  // Over the plain cap, so the body must carry a parse mode AND formatting a
  // reader can see: the bold subject is that formatting, and the HTML is what
  // the gate validates before any send.
  assert.ok(text.length > 280, `the body is ${text.length} chars`);
  assert.equal(opts.parseMode, "HTML", "past the plain cap the body ships formatted");
  assert.equal(text.startsWith("<b>Adherence · rung 3 · one rule</b>\n"), true);
});

await test("fixture 9: a rule carrying markup is escaped, and a quoted rule is not quoted twice", async () => {
  const HOSTILE = "[braid-whisper - enforcement @ 10:00 MSK]\nUse <b>bold</b> & more";
  const branch = append([], "h", 4, HOSTILE);
  const spy = senderSpy();
  await wiring.checkAdherence(ctxFor(branch, "digest-escape"), {
    sender: spy.factory,
    now: () => T0,
  });
  assert.equal(spy.sent.length, 1);
  const { text } = spy.sent[0];
  const lines = assertFrozenBody(text, "escaped");
  assert.equal(
    lines[1].includes("&lt;b&gt;bold&lt;/b&gt; &amp; more"),
    true,
    "markup in a rule cannot become markup in the digest",
  );
  assert.deepEqual(
    [...text.matchAll(/<\/?[a-z-]+>/g)].map((m) => m[0]),
    ["<b>", "</b>"],
    "the only tags on the wire are the subject's own pair",
  );

  // A body that already carries its own quotation marks is not quoted twice.
  const alreadyQuoted =
    '[braid-whisper - enforcement @ 10:00 MSK]\n"Babysit three workers and read each forest outcome write"';
  const quotedSpy = senderSpy();
  await wiring.checkAdherence(ctxFor(append([], "k", 4, alreadyQuoted), "digest-quoted"), {
    sender: quotedSpy.factory,
    now: () => T0,
  });
  assert.equal(quotedSpy.sent.length, 1);
  const quotedText = quotedSpy.sent[0].text;
  assert.equal(
    quotedText.includes(
      'The rule "Babysit three workers and read each forest outcome write" (enforcement/whisper)',
    ),
    true,
  );
  assert.equal(quotedText.includes('""'), false, "one pair of quotes, not two");
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
