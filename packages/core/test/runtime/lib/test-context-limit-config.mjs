/**
 * config-tunable context limit (braid.context.contextLimitTokens).
 *
 * Charter: ONE resolver in
 * lib/config/braid-settings.ts caps the effective context window braid uses
 * for its computations; the provider catalog keeps true model context size.
 *
 * Behaviors pinned here:
 * A. Resolver precedence (pure resolveContextLimitTokens):
 * unset → provider/model value; set → a CEILING: min(cap, provider) when
 * the provider window is known and positive, else the cap; invalid
 * (0, negative, non-number, non-finite) → provider value, no throw.
 * B. Invalid value logs ONCE per process (buffered logger, TUI-safe).
 * C. Density evaluator uses the resolved window (not hardcoded 100k) —
 * tokenRatio changes with the override (fixture: provider window 1M,
 * override 262000) and returns to provider truth on an invalid value.
 * D. analysis.ts fallback uses the resolved window when ctx usage is
 * unavailable; 200000 only as the historical last-resort floor.
 * E. context-tiers getContextUsage reports the effective window and
 * recomputes percent against it when tokens are known (pass-through
 * when unset or equal).
 *
 * Settings isolation: HOME is redirected to a temp dir BEFORE the dist
 * imports (os.homedir() reads $HOME on POSIX), so no live settings.json is
 * read or written (same pattern as test-double-enter.mjs). The reader reads
 * fresh on every call, so the fixture writes settings.json between phases.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate settings: temp home without settings.json. MUST precede imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w83-context-limit-"));
process.env.HOME = FAKE_HOME;
const SETTINGS_PATH = join(FAKE_HOME, ".pi", "agent", "settings.json");

const { resolveContextLimitTokens, getResolvedContextWindow, getConfiguredContextLimitTokens } =
  await import("../../../dist/lib/config/braid-settings.js");
const { getLogBuffer } = await import("../../../dist/lib/core/logger.js");
const { getContextUsage } = await import("../../../dist/lib/detection/context-tiers.js");
const { resolveWindow } = await import("../../../dist/lib/detection/context-usage.js");
const { evaluateContextDensity } = await import("../../../dist/lib/detection/context-density.js");
const { analyzeSession } =
  await import("../../../dist/extensions/memory/context-manager/analysis.js");

console.log("=== contextLimitTokens resolver + consumers ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

const PROVIDER_WINDOW = 1_048_576;
const OVERRIDE = 262_000;

function writeSettings(braid) {
  if (braid === null) {
    rmSync(SETTINGS_PATH, { force: true });
    return;
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify({ braid }));
}
// The temp home has no .pi/agent chain yet — create it up front.
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

function countBraidSettingsLogs() {
  return getLogBuffer().filter((e) => e.source === "braid-settings").length;
}

// ── A. Resolver precedence (pure — no settings coupling) ─────────────────────
test("unset → provider/model value", () => {
  assert.equal(resolveContextLimitTokens(undefined, PROVIDER_WINDOW), PROVIDER_WINDOW);
  assert.equal(resolveContextLimitTokens(undefined, 262144), 262144);
});

test("unset, no provider window → undefined (caller default applies)", () => {
  assert.equal(resolveContextLimitTokens(undefined, undefined), undefined);
  assert.equal(resolveContextLimitTokens(undefined, null), undefined);
});

test("set → ceiling: binds below the provider window, clamps above it", () => {
  assert.equal(resolveContextLimitTokens(OVERRIDE, PROVIDER_WINDOW), OVERRIDE);
  assert.equal(
    resolveContextLimitTokens(1000, 500),
    500,
    "a cap above the provider window clamps to the provider (ceiling, never a widening)",
  );
  assert.equal(
    resolveContextLimitTokens(1000, undefined),
    1000,
    "an unknown provider window leaves the cap standing alone",
  );
});

// ── B. Invalid value logs exactly once per process (buffered, TUI-safe) ──────
// Snapshot BEFORE the first invalid resolve in this process; the sweep below
// is that first.
const logsBeforeInvalid = countBraidSettingsLogs();

test("invalid (0, negative, non-number, non-finite) → provider value, no throw", () => {
  for (const bad of [0, -1, -262000, "262000", null, NaN, Infinity, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveContextLimitTokens(bad, PROVIDER_WINDOW), PROVIDER_WINDOW, `bad=${bad}`);
  }
  assert.equal(resolveContextLimitTokens(0, undefined), undefined);
});

test("first invalid value logs once (safe log, no throw)", () => {
  assert.equal(countBraidSettingsLogs() - logsBeforeInvalid, 1, "exactly one warning emitted");
});

test("repeated invalid values do not warn again (log-once)", () => {
  for (let i = 0; i < 5; i++) resolveContextLimitTokens(-i - 2, PROVIDER_WINDOW);
  resolveContextLimitTokens("x", PROVIDER_WINDOW);
  assert.equal(countBraidSettingsLogs() - logsBeforeInvalid, 1, "still exactly one warning");
});

// ── Density + consumers fixtures ─────────────────────────────────────────────
// 400_000 chars → ceil(/4) = 100_000 tokens exactly (CHARS_PER_TOKEN = 4).
const BIG_TEXT = "a".repeat(400_000);
const TOKENS = 100_000;
const densityCtx = () => ({
  model: { contextWindow: PROVIDER_WINDOW },
  sessionManager: {
    getEntries: () => [{ type: "message", message: { role: "user", content: BIG_TEXT } }],
  },
});
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── C. Density uses the resolved window (provider truth, override, invalid) ──
test("density (no settings): tokenRatio uses provider window, not hardcoded 100k", () => {
  writeSettings(null);
  const r = evaluateContextDensity(densityCtx());
  assert.equal(r.totalTokens, TOKENS);
  assert.ok(
    near(r.tokenRatio, TOKENS / PROVIDER_WINDOW),
    `expected ${TOKENS / PROVIDER_WINDOW}, got ${r.tokenRatio}`,
  );
  assert.ok(r.tokenRatio < 1, "with the old 100k hardcode this ratio would clamp to 1");
});

test("density (override set): tokenRatio changes with the override", () => {
  writeSettings({ context: { contextLimitTokens: OVERRIDE } });
  const r = evaluateContextDensity(densityCtx());
  assert.ok(
    near(r.tokenRatio, TOKENS / OVERRIDE),
    `expected ${TOKENS / OVERRIDE}, got ${r.tokenRatio}`,
  );
  assert.ok(r.tokenRatio > TOKENS / PROVIDER_WINDOW, "override (262k < 1M) must raise the ratio");
});

test("density (invalid override 0): falls back to provider truth", () => {
  writeSettings({ context: { contextLimitTokens: 0 } });
  const r = evaluateContextDensity(densityCtx());
  assert.ok(near(r.tokenRatio, TOKENS / PROVIDER_WINDOW), `got ${r.tokenRatio}`);
});

// ── D. analysis.ts fallback ──────────────────────────────────────────────────
function auditCtx({ withAccessor = false, withModel = true } = {}) {
  const ctx = {
    sessionManager: { getTree: () => [], getBranch: () => [], getLabel: () => null },
  };
  if (withModel) ctx.model = { contextWindow: PROVIDER_WINDOW };
  if (withAccessor) {
    ctx.getContextUsage = () => ({ percent: 10, tokens: 20_000 });
  }
  return ctx;
}

test("analysis: ctx usage unavailable → resolved (overridden) window", () => {
  writeSettings({ context: { contextLimitTokens: OVERRIDE } });
  const audit = analyzeSession(auditCtx({ withAccessor: false }));
  assert.equal(audit.usage.contextWindow, OVERRIDE);
  assert.equal(audit.usage.percent, 0);
  assert.equal(audit.usage.tokens, 0);
});

test("analysis: degenerate accessor (no window) → resolved window, percent recomputed", () => {
  const audit = analyzeSession(auditCtx({ withAccessor: true }));
  assert.equal(audit.usage.contextWindow, OVERRIDE);
  // Consumer 1 (context-tiers) recomputes percent against the effective
  // window when tokens are known: 20000/262000*100 ≈ 7.6336 (pi's 10 was
  // computed against the 1M provider window).
  assert.ok(near(audit.usage.percent, (20_000 / OVERRIDE) * 100), `got ${audit.usage.percent}`);
  assert.equal(audit.usage.tokens, 20_000);
});

test("analysis: settings unset → provider truth via resolver; nothing known → 200000 floor", () => {
  writeSettings(null);
  const withModel = analyzeSession(auditCtx({ withAccessor: false, withModel: true }));
  assert.equal(withModel.usage.contextWindow, PROVIDER_WINDOW);
  const bare = analyzeSession(auditCtx({ withAccessor: false, withModel: false }));
  assert.equal(bare.usage.contextWindow, 200000);
});

// ── E. context-tiers getContextUsage effective-window override ───────────────
const tiersCtx = (usage) => ({ getContextUsage: () => usage });

test("tiers (no settings): accessor usage passes through untouched", () => {
  writeSettings(null);
  const raw = { tokens: 131_000, contextWindow: PROVIDER_WINDOW, percent: 12.5 };
  const u = getContextUsage(tiersCtx(raw));
  assert.equal(u.contextWindow, PROVIDER_WINDOW);
  assert.equal(u.percent, 12.5);
});

test("tiers (override set): window capped and percent recomputed from tokens", () => {
  writeSettings({ context: { contextLimitTokens: OVERRIDE } });
  const u = getContextUsage(
    tiersCtx({ tokens: 131_000, contextWindow: PROVIDER_WINDOW, percent: 12.5 }),
  );
  assert.equal(u.contextWindow, OVERRIDE);
  assert.ok(near(u.percent, (131_000 / OVERRIDE) * 100), `got ${u.percent}`);
});

test("tiers (override set, tokens null): window overridden, pi percent kept", () => {
  const u = getContextUsage(
    tiersCtx({ tokens: null, contextWindow: PROVIDER_WINDOW, percent: null }),
  );
  assert.equal(u.contextWindow, OVERRIDE);
  assert.equal(u.percent, null);
});

test("tiers (invalid override 0): provider truth passes through", () => {
  writeSettings({ context: { contextLimitTokens: 0 } });
  const u = getContextUsage(
    tiersCtx({ tokens: 131_000, contextWindow: PROVIDER_WINDOW, percent: 12.5 }),
  );
  assert.equal(u.contextWindow, PROVIDER_WINDOW);
});

test("getResolvedContextWindow mirrors the pure resolver against live settings", () => {
  writeSettings({ context: { contextLimitTokens: OVERRIDE } });
  assert.equal(getResolvedContextWindow(PROVIDER_WINDOW), OVERRIDE);
  writeSettings(null);
  assert.equal(getResolvedContextWindow(PROVIDER_WINDOW), PROVIDER_WINDOW);
  assert.equal(getResolvedContextWindow(undefined), undefined);
});

test("resolveWindow: source label follows the binding bound under the ceiling", () => {
  writeSettings({ context: { contextLimitTokens: OVERRIDE } });
  const capped = resolveWindow(PROVIDER_WINDOW);
  assert.equal(capped.contextWindow, OVERRIDE, "cap below provider: the cap binds");
  assert.equal(capped.windowSource, "configured", "cap below provider: source is the cap");
  const clamped = resolveWindow(100_000);
  assert.equal(clamped.contextWindow, 100_000, "provider below cap: the provider binds");
  assert.equal(
    clamped.windowSource,
    "provider",
    "provider below cap: source is the provider window, not the inert cap",
  );
  writeSettings(null);
  assert.equal(resolveWindow(PROVIDER_WINDOW).windowSource, "provider", "unset: provider binds");
});

test("resolveWindow: an invalid configured value is unset - the provider window is labeled", () => {
  for (const invalid of [0, -262000, "262000", null]) {
    writeSettings({ context: { contextLimitTokens: invalid } });
    const w = resolveWindow(PROVIDER_WINDOW);
    assert.equal(w.contextWindow, PROVIDER_WINDOW, `invalid=${String(invalid)}: provider window`);
    assert.equal(
      w.windowSource,
      "provider",
      `invalid=${String(invalid)}: an invalid cap is unset; the provider window binds`,
    );
    assert.equal(
      getConfiguredContextLimitTokens(),
      undefined,
      `invalid=${String(invalid)}: the validated reader treats it as unset`,
    );
  }
  writeSettings(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== context-limit config tests passed ===");
