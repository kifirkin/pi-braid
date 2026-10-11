/**
 * Test: adherence meter — read-side per-rule counters, owner-only report, bounded escalation.
 *
 * Design ground: braid-docs research RECURRING-FAILURE-ROOT-CAUSES §6/§7 (rules need a
 * mechanical needle and a meter; the repo has no measured rule compliance) and
 * MODERN-PRACTICE §2/§6 (deterministic counters, owner-facing only, no judge, no
 * agent-visible aggregate score).
 *
 * Fixtures (brief order):
 * 1. Synthetic session entries -> exact per-rule deliveries/repeats/suppressions, the
 *    active-branch walk (an off-branch entry is never counted), digit collapse.
 * 2. Escalation: first crossing of K fires exactly one owner escalation; the milestone
 *    ladder gates the next ones; the per-session budget reaches terminal.
 * 3. Wiring: checkAdherence sends only through the owner sender, once per crossing.
 * 4. Report: schema, hold/not-hold history over the last k sessions, stable path, write.
 * 5. Isolation: no prompt-builder source reads the meter; the meter modules never write
 *    to the agent channel and never register a tool.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

console.log("=== adherence meter ===\n");

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
const wiring = await import(join(ROOT, "dist/extensions/enforcement/handlers/register-adherence-meter.js"));

// ── Fixture builders ────────────────────────────────────────────────────────

function entry(id, parentId, { source, content, display = true }) {
  return {
    type: "custom",
    customType: "braid_injection",
    data: {
      id: `inj-${id}`,
      type: "enforcement",
      source,
      content,
      timestamp: 1000,
      display,
      steer: false,
      turn: 0,
    },
    id,
    parentId,
    timestamp: "2026-10-08T00:00:00.000Z",
  };
}

function sessionFileText(entries, sessionId) {
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-10-08T00:00:00.000Z",
      cwd: "/tmp/proj",
    }),
  ];
  for (const e of entries) lines.push(JSON.stringify(e));
  return lines.join("\n") + "\n";
}

const ALPHA_1 = "[braid-whisper - enforcement @ 10:00 MSK]\nAlpha rule fired at 25/30";
const ALPHA_2 = "[braid-whisper - enforcement @ 10:05 MSK]\nAlpha rule fired at 26/30";
const ALPHA_3 = "[braid-whisper - enforcement @ 10:09 MSK]\nAlpha rule fired at 27/30";
const BETA_1 = "[braid-whisper - rule-b @ 10:01 MSK]\nBeta rule fired";
const BETA_2 = "[braid-whisper - rule-b @ 10:02 MSK]\nBeta rule fired twice";
const ALPHA_KEY = "enforcement/whisper::Alpha rule fired at #/#";

// ── 1. Aggregation: counts, branch walk, digit collapse ─────────────────────

await test("fixture 1: per-rule counts from a synthetic branch", async () => {
  const e1 = entry("e1", null, { source: "enforcement/whisper", content: ALPHA_1 });
  const e2 = entry("e2", "e1", { source: "enforcement/whisper", content: ALPHA_2 });
  const e3 = entry("e3", "e2", { source: "enforcement/whisper", content: ALPHA_1, display: false });
  const off = entry("x1", "e2", { source: "enforcement/whisper", content: ALPHA_3 });
  const e4 = entry("e4", "e3", { source: "rule-b", content: BETA_1 });
  const e5 = entry("e5", "e4", { source: "rule-b", content: BETA_2 });
  const e6 = entry("e6", "e5", { source: "enforcement/whisper", content: ALPHA_1 });
  const entries = [e1, e2, e3, off, e4, e5, e6];

  const branch = meter.activeBranchEntries(entries);
  assert.equal(branch.length, 6, `off-branch entry dropped (got ${branch.length})`);

  const rules = meter.aggregateRuleAdherence(branch);
  assert.equal(rules.length, 3, `three distinct rules (got ${rules.length})`);

  const alpha = rules.find((r) => r.rule === ALPHA_KEY);
  assert.ok(alpha, `alpha key present (${rules.map((r) => r.rule).join(" | ")})`);
  assert.equal(alpha.source, "enforcement/whisper");
  assert.equal(alpha.deliveries, 3, "3 deliveries on the branch (off-branch 4th not counted)");
  assert.equal(alpha.repeats, 2, "repeats = deliveries - 1");
  assert.equal(alpha.suppressions, 1, "display:false entry is a suppression");
  assert.equal(alpha.signal, "Alpha rule fired at 25/30", "signal is the envelope-stripped body");

  const beta1 = rules.find((r) => r.signal === "Beta rule fired");
  const beta2 = rules.find((r) => r.signal === "Beta rule fired twice");
  assert.ok(beta1 && beta2, "different bodies are different rules");
  assert.equal(beta1.deliveries, 1);
  assert.equal(beta2.deliveries, 1);
});

await test("fixture 1: stripWhisperEnvelope removes the header line", async () => {
  assert.equal(meter.stripWhisperEnvelope(ALPHA_1), "Alpha rule fired at 25/30");
  assert.equal(meter.stripWhisperEnvelope("no envelope here"), "no envelope here");
});

await test("fixture 1: verdict is repeats < K", async () => {
  assert.equal(meter.ruleHolds(2), true);
  assert.equal(meter.ruleHolds(3), false);
  assert.equal(meter.ruleHolds(9), false);
  assert.equal(meter.ADHERENCE_REPEAT_THRESHOLD_K, 3);
});

// ── 2. Escalation ladder + budget ───────────────────────────────────────────

await test("fixture 2: ladder fires once per rung, terminal after the last", async () => {
  const state = meter.createEscalationState();
  assert.equal(meter.planEscalation(state, "r1", 2).fire, false, "below K: no fire");

  const first = meter.planEscalation(state, "r1", 3);
  assert.equal(first.fire, true, "K crossing fires");
  assert.equal(first.milestone, 3);
  meter.markEscalated(state, "r1");

  assert.equal(meter.planEscalation(state, "r1", 3).fire, false, "same rung does not re-fire");
  assert.equal(meter.planEscalation(state, "r1", 5).fire, false, "still below the next rung");

  const second = meter.planEscalation(state, "r1", 6);
  assert.equal(second.fire, true, "2K crossing fires");
  assert.equal(second.milestone, 6);
  meter.markEscalated(state, "r1");

  const third = meter.planEscalation(state, "r1", 15);
  assert.equal(third.fire, true, "5K crossing fires");
  meter.markEscalated(state, "r1");

  const terminal = meter.planEscalation(state, "r1", 500);
  assert.equal(terminal.fire, false, "rule is terminal after the last rung");
  assert.equal(terminal.reason, "rule-terminal");
});

await test("fixture 2: per-session budget stops the next escalations", async () => {
  const state = meter.createEscalationState();
  for (let i = 0; i < meter.ADHERENCE_ESCALATION_BUDGET_PER_SESSION; i++) {
    const rule = `rule-${i}`;
    assert.equal(meter.planEscalation(state, rule, 99).fire, true, `rule-${i} fires`);
    meter.markEscalated(state, rule);
  }
  assert.equal(state.total, meter.ADHERENCE_ESCALATION_BUDGET_PER_SESSION);
  const blocked = meter.planEscalation(state, "rule-new", 99);
  assert.equal(blocked.fire, false, "budget exhausted: no fire");
  assert.equal(blocked.reason, "session-terminal");
});

// ── 3. Wiring: one escalation per crossing, owner channel only ──────────────

await test("fixture 3: checkAdherence fires exactly once per crossing", async () => {
  const mk = (id, parentId) => entry(id, parentId, { source: "enforcement/whisper", content: ALPHA_1 });
  const entries = [mk("w1", null), mk("w2", "w1"), mk("w3", "w2"), mk("w4", "w3")]; // 4 deliveries = 3 repeats
  const sent = [];
  const ctx = {
    cwd: "/tmp/proj",
    sessionManager: {
      getBranch: () => entries,
      getSessionFile: () => null,
      getSessionId: () => "wiring-s1",
    },
  };
  const deps = { sender: () => (text) => (sent.push(text), true), now: () => 1791486000000 };

  const r1 = await wiring.checkAdherence(ctx, deps);
  assert.equal(r1.fired.length, 1, "one escalation at the K crossing");
  assert.equal(sent.length, 1, "one owner message");
  assert.ok(sent[0].includes("Alpha rule fired"), `message names the signal (${sent[0]})`);
  assert.ok(!sent[0].includes("[braid-whisper"), "message is not the raw whisper envelope");

  const r2 = await wiring.checkAdherence(ctx, deps);
  assert.equal(r2.fired.length, 0, "no re-fire on the same counts");
  assert.equal(sent.length, 1);

  entries.push(entry("w5", "w4", { source: "enforcement/whisper", content: ALPHA_1 }));
  entries.push(entry("w6", "w5", { source: "enforcement/whisper", content: ALPHA_1 }));
  entries.push(entry("w7", "w6", { source: "enforcement/whisper", content: ALPHA_1 })); // 7 deliveries = 6 repeats
  const r3 = await wiring.checkAdherence(ctx, deps);
  assert.equal(r3.fired.length, 1, "second rung fires at 2K");
  assert.equal(sent.length, 2);
});

await test("fixture 3: absent sender leaves the rung unspent (retry later)", async () => {
  const entries = [
    entry("n1", null, { source: "enforcement/whisper", content: BETA_1 }),
    entry("n2", "n1", { source: "enforcement/whisper", content: BETA_1 }),
    entry("n3", "n2", { source: "enforcement/whisper", content: BETA_1 }),
    entry("n4", "n3", { source: "enforcement/whisper", content: BETA_1 }),
  ];
  const ctx = {
    cwd: "/tmp/proj",
    sessionManager: {
      getBranch: () => entries,
      getSessionFile: () => null,
      getSessionId: () => "wiring-s2",
    },
  };
  const none = await wiring.checkAdherence(ctx, { sender: () => null });
  assert.equal(none.fired.length, 0, "no channel: nothing fired");

  const sent = [];
  const later = await wiring.checkAdherence(ctx, {
    sender: () => (text) => (sent.push(text), true),
  });
  assert.equal(later.fired.length, 1, "the unspent rung fires when the channel appears");
  assert.equal(sent.length, 1);
});

// ── 4. Report: schema, rolling history, stable path, write ──────────────────

await test("fixture 4: report carries per-rule counts and the last-k hold view", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adherence-"));
  try {
    const oldEntries = [
      entry("o1", null, { source: "enforcement/whisper", content: ALPHA_1 }),
      entry("o2", "o1", { source: "enforcement/whisper", content: ALPHA_1 }),
      entry("o3", "o2", { source: "enforcement/whisper", content: ALPHA_1 }),
      entry("o4", "o3", { source: "enforcement/whisper", content: ALPHA_1 }),
    ]; // 3 repeats -> not held
    const midEntries = [entry("m1", null, { source: "enforcement/whisper", content: ALPHA_1 })]; // held
    const curEntries = [
      entry("c1", null, { source: "enforcement/whisper", content: ALPHA_1 }),
      entry("c2", "c1", { source: "enforcement/whisper", content: ALPHA_1 }),
      entry("c3", "c2", { source: "enforcement/whisper", content: BETA_1 }),
      entry("c4", "c3", { source: "enforcement/whisper", content: BETA_1 }),
      entry("c5", "c4", { source: "enforcement/whisper", content: BETA_1 }),
    ]; // alpha 1 repeat (held), beta 2 repeats (held)
    const oldFile = join(dir, "2026-10-01T00-00-00-000Z_aaa.jsonl");
    const midFile = join(dir, "2026-10-02T00-00-00-000Z_bbb.jsonl");
    const curFile = join(dir, "2026-10-03T00-00-00-000Z_ccc.jsonl");
    writeFileSync(oldFile, sessionFileText(oldEntries, "s-old"));
    writeFileSync(midFile, sessionFileText(midEntries, "s-mid"));
    writeFileSync(curFile, sessionFileText(curEntries, "s-cur"));

    const state = meter.createEscalationState();
    state.violations.enforcement = 2;

    const input = {
      entries: curEntries,
      sessionId: "s-cur",
      sessionFile: curFile,
      cwd: "/tmp/proj",
      escalation: state,
    };
    const report = meter.buildAdherenceReport(input, { k: 3, now: () => Date.UTC(2026, 9, 3, 12) });

    assert.equal(report.schema, "braid-adherence-report/1");
    assert.equal(report.k, 3);
    assert.equal(report.session.id, "s-cur");

    const alpha = report.rules.find((r) => r.rule === ALPHA_KEY);
    assert.ok(alpha, "alpha rule present");
    assert.equal(alpha.deliveries, 2);
    assert.equal(alpha.repeats, 1);
    assert.equal(alpha.held, true);
    assert.equal(alpha.history.length, 3, "three sessions in the rolling view");
    assert.equal(alpha.history[0].sessionId, "s-old", "oldest first");
    assert.equal(alpha.history[2].sessionId, "s-cur", "current last");
    assert.equal(alpha.history[0].held, false, "3 repeats in s-old: not held");
    assert.equal(alpha.history[1].held, true, "1 delivery in s-mid: held");
    assert.equal(alpha.history[2].held, true, "1 repeat in s-cur: held");

    assert.deepEqual(report.violations, [{ rule: "enforcement", count: 2 }]);
    assert.equal(report.escalation.budget, meter.ADHERENCE_ESCALATION_BUDGET_PER_SESSION);

    const outDir = join(dir, "out");
    const written = meter.writeAdherenceReport(input, {
      k: 3,
      reportDir: outDir,
      now: () => Date.UTC(2026, 9, 3, 12),
    });
    assert.equal(written.ok, true, `write ok (${written.error ?? ""})`);
    assert.equal(written.path, join(outDir, "report.jsonl"));
    assert.ok(existsSync(written.path), "report file exists");
    const lines = readFileSync(written.path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "one JSONL line per session end");
    const onDisk = JSON.parse(lines[lines.length - 1]);
    assert.equal(onDisk.session.id, "s-cur");
    assert.ok(Array.isArray(onDisk.rules) && onDisk.rules.length >= 2);

    // Append-only: a second session end adds a line instead of clobbering.
    const second = meter.writeAdherenceReport(
      { ...input, sessionId: "s-next" },
      { k: 3, reportDir: outDir, now: () => Date.UTC(2026, 9, 3, 13) },
    );
    assert.equal(second.ok, true);
    const after = readFileSync(written.path, "utf8").trim().split("\n");
    assert.equal(after.length, 2, "append-only, no clobber");
    assert.equal(JSON.parse(after[after.length - 1]).session.id, "s-next");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("fixture 4: report path is the stable braid path", async () => {
  const p = meter.adherenceReportPath();
  assert.ok(
    p.endsWith(join(".pi", "agent", "braid", "adherence", "report.jsonl")),
    `stable path (${p})`,
  );
});

await test("fixture 4: finalizeAdherence writes the report at shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adherence-fin-"));
  try {
    const entries = [
      entry("f1", null, { source: "enforcement/whisper", content: ALPHA_1 }),
      entry("f2", "f1", { source: "enforcement/whisper", content: ALPHA_1 }),
      entry("f3", "f2", { source: "enforcement/whisper", content: ALPHA_1 }),
      entry("f4", "f3", { source: "enforcement/whisper", content: ALPHA_1 }),
    ];
    const sessionFile = join(dir, "2026-10-04T00-00-00-000Z_fff.jsonl");
    writeFileSync(sessionFile, sessionFileText(entries, "s-fin"));
    const ctx = {
      cwd: "/tmp/proj",
      sessionManager: {
        getBranch: () => entries,
        getSessionFile: () => sessionFile,
        getSessionId: () => "s-fin",
      },
    };
    const result = wiring.finalizeAdherence(ctx, { reportDir: join(dir, "out"), k: 3 });
    assert.equal(result.ok, true, `write ok (${result.error ?? ""})`);
    const onDisk = JSON.parse(readFileSync(result.path, "utf8"));
    assert.equal(onDisk.session.id, "s-fin");
    const alpha = onDisk.rules.find((r) => r.rule === ALPHA_KEY);
    assert.ok(alpha, "alpha rule present");
    assert.equal(alpha.held, false, "3 repeats: not held");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. Isolation: never in the agent's context ──────────────────────────────

await test("fixture 5: no prompt-builder source reads the meter or its report", async () => {
  const pbDir = join(ROOT, "src/extensions/core/prompt-builder");
  const files = readdirSync(pbDir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, "prompt-builder has sources");
  for (const f of files) {
    const src = readFileSync(join(pbDir, f), "utf8");
    assert.ok(!/adherence/i.test(src), `prompt-builder/${f} must not reference adherence`);
  }
});

await test("fixture 5: meter modules never write to the agent channel", async () => {
  const rels = [
    "src/lib/enforcement/adherence-meter.ts",
    "src/extensions/enforcement/handlers/register-adherence-meter.ts",
  ];
  for (const rel of rels) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(!/sendTrackedMessage|sendMessage\s*\(|registerTool/.test(src), `${rel} is owner-only`);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
