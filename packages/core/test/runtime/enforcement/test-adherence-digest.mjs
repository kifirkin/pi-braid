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
 *   6. the digest body is one screen: short lines, only `<b>`, under 280 chars.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
  assert.match(text, /^<b>adherence · rung 3<\/b>/, "bold subject names the rung");
  assert.match(text, /\nrules 2\n/, "the digest states how many rules it folded");
  assert.match(text, /\ndeliveries 4\n/);
  assert.match(text, /\nrepeats 3\n/);
  assert.match(text, /\nsuppressed 1\n/, "the owner sees how many were held back");
  assert.match(text, /\nsession digest-s1\n/);
  assert.match(text, /\nat /);
  assert.match(text, /\nwhere .*report\.jsonl$/, "points at the full signal");

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
  assert.match(spy.sent[1].text, /\nsuppressed 0\n/);
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

// ── 6. The body is one screen ─────────────────────────────────────────────

await test("fixture 6: the digest is short, uses only <b>, and fits the plain cap", async () => {
  const longSignal = `[braid-whisper - enforcement @ 10:00 MSK]\n${"Very long rule text ".repeat(20)}`;
  const branch = append([], "s", 4, longSignal);
  append(branch, "t", 4, BETA, "rule-b");
  const ctx = ctxFor(branch, "digest-shape");
  const spy = senderSpy();
  await wiring.checkAdherence(ctx, {
    sender: spy.factory,
    now: () => T0,
  });
  assert.equal(spy.sent.length, 1);
  const text = spy.sent[0].text;
  assert.ok(text.length <= 280, `digest is ${text.length} chars — one screen`);
  for (const line of text.split("\n")) {
    assert.ok(line.length <= 72, `line too long (${line.length}): ${line}`);
  }
  const tags = [...text.matchAll(/<[^>]+>/g)].map((m) => m[0]);
  assert.ok(tags.length > 0, "the subject is bold");
  for (const tag of tags) {
    assert.ok(tag === "<b>" || tag === "</b>", `only <b> is used, saw ${tag}`);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
