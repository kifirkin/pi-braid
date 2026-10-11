/**
 * Part 1 + Part 4: token-gated advisory whisper path.
 *
 * Evidence (session audit): a measured session
 * (262 turns, 1M window, 150-238k tokens for 154 turns) fired ZERO
 * high-context advisories — the context-lifecycle proposal real-need gate
 * and urgent-bypass were percent-of-window only, unreachable at 1M.
 *
 * This fixture pins BOTH layers of the fix:
 * A. Source scan — the advisory gates reference the token constants from
 * context-thresholds.ts (single owner), never bare percent literals or
 * restated token literals.
 * B. Functional — the REAL compiled context-lifecycle before_agent_start
 * hook driven on the window actually configured (256k), where act =
 * min(0.60W, 130k) = 130k and soft = 0.18W = 46,080:
 * 1. percent just under the 55% floor / tokens just over act -> the token
 *    arm opens the gate: proposals land
 * 2. percent under the floor / tokens in [soft, act) -> a token-signal
 *    proposal exists but neither arm opens: still suppressed
 * 3. tokens >= backstop arm (0.90W) -> the token urgent arm: same-class
 *    re-fire bypasses dedupe
 *
 * The 256k window is load-bearing for case 2: the suppression band
 * [soft, act) is non-empty only while soft < act, i.e. below W = 722,222.
 * The clamp emptied that band at the fixture's former 1M scope (soft 180k >
 * floor 130k), which is why the case went vacuous there.
 *
 * Run: node test/runtime/lib/test-advisory-token-gate.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src");

// ── Hermetic settings isolation (re-baseline) ───────────────────────────
// The functional block drives the REAL compiled pipeline, which resolves the
// effective context window through the ONE resolver
// (lib/config/braid-settings.ts) whose reader hits
// <homedir()>/.pi/agent/settings.json. Redirect HOME to a temp dir BEFORE the
// dist imports (os.homedir() reads $HOME on POSIX — same seam as
// test-context-limit-config.mjs; mock.method(os, "homedir") is not viable
// because braid-settings captures the named import and bakes
// SETTINGS_PATH at module-eval time) and write the EXPLICIT contextLimitTokens
// this scenario pins: 256_000, the window actually configured and the live
// regime where the gate's suppression band [soft, act) is non-empty. The
// suite passes regardless of what live settings.json says.
const W = 256_000;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-advisory-gate-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: W } } }),
);

const { clearAllBuckets } = await import(
  "file://" + join(ROOT, "dist/lib/utils/injection-tracker.js")
);
const { _resetForTests } = await import(
  "file://" + join(ROOT, "dist/lib/enforcement/turn-dedup.js")
);
const { clearExtensionState } = await import(
  "file://" + join(ROOT, "dist/lib/state/extension-state.js")
);
const { _getState } = await import(
  "file://" + join(ROOT, "dist/extensions/memory/context-lifecycle/state.js")
);
const { default: contextLifecycleExtension } = await import(
  "file://" + join(ROOT, "dist/extensions/memory/context-lifecycle/index.js")
);
const { tokenArms } = await import("file://" + join(ROOT, "dist/lib/detection/context-usage.js"));
const ARMS = tokenArms(W);
// Case payloads derive from the fixture arms, so a case name cannot drift
// from its payload (the vacuity this fixture was rebuilt to prevent).
const pctOf = (tokens) => Math.round((tokens / W) * 100);
const ACT_MARGIN = Math.max(ARMS.act, ARMS.soft) + 1_000; // over act, under the 55% floor
const SUPPRESS_MID = Math.round((ARMS.soft + ARMS.act) / 2); // mid [soft, act)
const URGENT_BAND = ARMS.backstop + 1_000; // backstop band

console.log("=== token-gated advisory path (gate + urgent + ladder constants) ===\n");

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

// ── A. Source scan: gates reference token constants, never bare literals ────

const lifecycleSrc = readFileSync(
  join(SRC, "extensions/memory/context-lifecycle/index.ts"),
  "utf-8",
);
const thresholdsSrc = readFileSync(join(SRC, "lib/detection/context-thresholds.ts"), "utf-8");
const analysisSrc = readFileSync(
  join(SRC, "extensions/memory/context-manager/analysis.ts"),
  "utf-8",
);

await test("A1. context-thresholds.ts owns the advisory token ladder via tokenArms", () => {
  for (const c of [
    "USAGE_TOKENS_CRITICAL",
    "HYGIENE_AUTO_COMPACT_HARD_BACKSTOP",
    "USAGE_TOKENS_ESCALATE",
  ]) {
    assert.ok(
      new RegExp(`export function ${c}\\(window`).test(thresholdsSrc),
      `${c} must be an exported resolver-driven arm in context-thresholds.ts (single owner)`,
    );
  }
  assert.match(
    thresholdsSrc,
    /import \{ tokenArms \} from "\.\/context-usage\.js";/,
    "the numeric table lives in lib/detection/context-usage.ts (tokenArms)",
  );
});

await test("A2. lifecycle gate constants bind to token constants (no restated literals)", () => {
  assert.match(
    lifecycleSrc,
    /PROPOSAL_ACTIONABLE_TOKENS = USAGE_TOKENS_CRITICAL\(\);/,
    "gate token arm = USAGE_TOKENS_CRITICAL() (imported, not restated)",
  );
  assert.match(
    lifecycleSrc,
    /PROPOSAL_URGENT_TOKENS = HYGIENE_AUTO_COMPACT_HARD_BACKSTOP\(\);/,
    "urgent token arm = HYGIENE_AUTO_COMPACT_HARD_BACKSTOP (imported, not restated)",
  );
  assert.match(
    lifecycleSrc,
    /import \{[^}]*USAGE_TOKENS_CRITICAL[^}]*USAGE_TOKENS_ESCALATE[^}]*\} from "\.\.\/\.\.\/\.\.\/lib\/detection\/context-thresholds\.js";/,
    "token constants imported from the single owner",
  );
  // No restated token literals in the gate block (the single-owner ban).
  assert.doesNotMatch(
    lifecycleSrc,
    /PROPOSAL_ACTIONABLE_TOKENS = [0-9_]+;/,
    "gate constant must not restate a bare literal",
  );
});

await test("A3. gate decision carries BOTH arms (min(percent, token) semantics)", () => {
  // The no-actionable-need branch must consult tokens, not just usage percent.
  assert.match(
    lifecycleSrc,
    /usage < PROPOSAL_ACTIONABLE_USAGE &&\s*\n\s*tokens < PROPOSAL_ACTIONABLE_TOKENS/,
    "no-actionable-need requires BOTH floors low (either arm opens the gate)",
  );
  // Urgent bypass has a token arm too.
  assert.match(
    lifecycleSrc,
    /if \(tokens >= PROPOSAL_URGENT_TOKENS\) return true;/,
    "urgent bypass has the token arm",
  );
});

await test("A4. compact-nudge ladder escalates on token bands", () => {
  assert.match(
    lifecycleSrc,
    /tokens >= USAGE_TOKENS_ESCALATE\?*[^;]*Escalated:/s,
    ">= escalate band (0.85W) wording escalation present",
  );
  assert.match(
    lifecycleSrc,
    /usage >= 80 \|\| tokens >= HYGIENE_AUTO_COMPACT_HARD_BACKSTOP/,
    "full-pipeline message on either arm",
  );
});

await test("A5. context-manager audit recommendations carry token arms", () => {
  assert.match(analysisSrc, /usage\.percent > 80 \|\| usage\.tokens >= arms\.backstop/);
  assert.match(analysisSrc, /usage\.percent > 60 \|\| usage\.tokens >= arms\.act/);
  assert.match(
    analysisSrc,
    /usage\.percent > CONTEXT_COMPACT_REFUSE_PERCENT \|\| usage\.tokens >= arms\.escalate/,
  );
});

// ── B. Functional: the real extension on the configured (256k) window ───────

let harnessSeq = 0;
function makeHarness(percent, tokens) {
  const entries = [];
  const sessionId = `token-gate-${harnessSeq++}-${Date.now()}`;
  let usage = percent;
  let tok = tokens;
  const pi = {
    handlers: new Map(),
    tools: null,
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    registerTool(tool) {
      this.tools = tool;
    },
    sendMessage() {},
    sendUserMessage() {},
  };
  const ctx = {
    sessionManager: {
      getSessionFile: () => `fake-${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getEntries: () => entries.slice(),
      getBranch: () => [],
      appendCustomMessageEntry: (type, content, persistent, meta) => {
        const id = `e${entries.length}`;
        entries.push({
          id,
          type: "custom_message",
          customType: type,
          content,
          persistent,
          details: meta,
        });
        return id;
      },
    },
    // contextWindow = the fixture's effective window (matches the explicit
    // contextLimitTokens above, so the normalization in getContextUsage is
    // a pass-through and both arms are read verbatim — the min(percent, token)
    // semantics under test).
    getContextUsage: () => ({ percent: usage, tokens: tok, contextWindow: W }),
  };
  contextLifecycleExtension(pi);
  return {
    pi,
    ctx,
    entries,
    setUsage(p) {
      usage = p;
    },
    setTokens(t) {
      tok = t;
    },
    rearm(...policyIds) {
      const s = _getState(ctx);
      for (const id of policyIds) s.policyEngine.cooldowns.delete(id);
    },
    runTurn() {
      const p = pi.handlers.get("before_agent_start");
      assert.ok(p, "before_agent_start handler must be registered");
      return p({ prompt: "token gate fixture" }, ctx);
    },
    state() {
      return _getState(ctx);
    },
  };
}

function freshState(h) {
  clearExtensionState(h.ctx, "context-lifecycle");
  const s = h.state();
  s.proposalKeysSeeded = false;
  s.proposalKeys.clear();
  s.proposalIgnoredTurns.clear();
  s.declinedKeys.clear();
  s.lastContextActionTurn = 0;
}

const TOKEN_POLICY_IDS = ["tokens-soft", "tokens-advisory", "tokens-warning"];

// B1. THE TOKEN-ARM BAND: percent sits just under the 55% floor while tokens
// clear act. The token arm alone opens the gate here; pre-clamp the floor at
// this window was 0.60W = 153,600, so this same payload was suppressed.
await test(
  `B1. 256k window @ ${pctOf(ACT_MARGIN)}%, tokens ${ACT_MARGIN} (just over act): the token arm opens the gate`,
  async () => {
  clearAllBuckets();
  _resetForTests();
  assert.ok(
    pctOf(ACT_MARGIN) < 55,
    "fixture sanity: percent must stay under the floor or the token arm is not the deciding lever",
  );
  // The fixture must clear both floors that matter: the actionable token arm
  // (act) and the first token signal (soft) - below soft no proposal exists
  // to gate at all. At 256k the binding floor is act.
  const h = makeHarness(pctOf(ACT_MARGIN), ACT_MARGIN);
  freshState(h);
  await h.runTurn();
  assert.ok(
    h.entries.length >= 1,
    "above the actionable token floor the advisory gate must open even below 55% of the configured window",
  );
  const delivered = h.entries.filter((e) => TOKEN_POLICY_IDS.includes(e.details?.policy_id));
  assert.ok(
    delivered.length >= 1,
    "the fired proposals are the token-class advisories (tokens-soft/advisory/warning)",
  );
  assert.ok(
    h.entries.every((e) => (e.details?.message ?? e.content?.[0]?.text ?? "").length > 0),
    "delivered entries carry a message body",
  );
});

// B2. THE SUPPRESSION BAND [soft, act): a token-signal proposal exists but
// neither gate arm opens. The band is non-empty only while soft < act, which
// holds below W = 722,222; at the old 1M scope the clamp emptied it. The
// sanity assert keeps this from going vacuous again if the arms ever move.
await test(
  `B2. 256k window @ ${pctOf(SUPPRESS_MID)}%, tokens ${SUPPRESS_MID} in [soft ${ARMS.soft}, act ${ARMS.act}): neither arm opens, gate still suppresses`,
  async () => {
  clearAllBuckets();
  _resetForTests();
  assert.ok(
    SUPPRESS_MID >= ARMS.soft && SUPPRESS_MID < ARMS.act,
    "fixture sanity: the payload must sit in [soft, act) or the suppression case tests nothing",
  );
  const h = makeHarness(pctOf(SUPPRESS_MID), SUPPRESS_MID);
  freshState(h);
  await h.runTurn();
  assert.equal(
    h.entries.length,
    0,
    "below both floors (percent < 55, tokens < act) the advisory stays suppressed even though the token signal fired",
  );
});

// B3. Urgent band: tokens clear the backstop arm, so a same-class re-fire
// bypasses gate + dedupe. Percent is pinned low on purpose: the coherent
// percent at this token count (90%) would satisfy the percent urgent arm too
// and mask a broken token urgent arm.
await test(
  `B3. 256k window, tokens ${URGENT_BAND} (>= backstop): the token urgent arm re-fires through gate + dedupe`,
  async () => {
  clearAllBuckets();
  _resetForTests();
  assert.ok(URGENT_BAND >= ARMS.backstop, "fixture sanity: the payload must clear the backstop arm");
  const h = makeHarness(20, URGENT_BAND);
  freshState(h);
  await h.runTurn();
  assert.ok(h.entries.length >= 1, "urgent band (>= backstop arm) delivers");
  const afterFirst = h.entries.length;
  h.rearm(...TOKEN_POLICY_IDS);
  await h.runTurn();
  assert.ok(
    h.entries.length > afterFirst,
    "a re-armed urgent-band proposal re-fires (urgency preserved at any window)",
  );
});

await test("B4. sub-1M window behavior unchanged: percent arm alone still opens the gate", async () => {
  clearAllBuckets();
  _resetForTests();
  // tokens null = UNKNOWN (pi-core ContextUsage.tokens is number | null).
  // The old 0 sentinel is a KNOWN zero under the percent recompute (it
  // would recompute the percent arm to 0%); null keeps the percent arm as the
  // only signal, which is what this scenario means by "unknown token counts".
  const h = makeHarness(60, null); // 60% >= 55, tokens unknown
  freshState(h);
  await h.runTurn();
  assert.ok(
    h.entries.length >= 1,
    "percent arm alone still fires (no regression for sub-1M windows / unknown token counts)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
