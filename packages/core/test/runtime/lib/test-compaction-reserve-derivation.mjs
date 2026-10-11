/**
 * Compaction reserve derivation (braid.context.contextLimitTokens -> reserve).
 *
 * Charter: pi-core decides WHEN native threshold compaction fires from
 * `contextTokens > contextWindow - reserveTokens` - a fixed token count, not
 * a share of the window. braid plums its configured window into the session
 * model, so the reserve must be derived from that same window or the trigger
 * silently re-anchors to an arbitrary percent. ONE pure resolver owns the
 * split (resolveCompactionReserveTokens), and the reserve reads back through
 * pi-core's own reader in the composed fixture
 * (test/runtime/core/test-configured-window-native-compaction.mjs).
 *
 * Behaviors pinned here:
 * A. 75/25 split: reserve = window - round(window * USAGE_WHISPER_CRITICAL/100)
 * (196000 -> 49000/147000; 128000 -> 32000/96000; 256000 -> 64000/192000;
 * 1048576 -> 262144/786432), trigger percent the band target by identifier.
 * B. Floor: a reserve thinner than pi-core's own default
 * (MIN_COMPACTION_RESERVE_TOKENS) never wins - small windows trade the exact
 * percent for a usable summary budget, and the floor is visible in the result.
 * C. Refusal: invalid windows and windows that the floor consumes entirely
 * return undefined (caller keeps pi-core defaults) instead of a nonsense split.
 * D. Band containment: every derivation with room left sits inside
 * (USAGE_WHISPER_WARNING, USAGE_COMPACT_MEDIUM) - the band braid's usage
 * layers already work in - read from the real constants, not copies.
 * E. Configured reserve resolution: per-model modelOverrides win over the
 * ordinary setting; invalid values are ignored (pi-core's own default lands).
 * F. Effective window: the applier derives on the same window the plumb
 * writes or keeps - min(cap, true window) when the true window is known - and
 * reports window-not-plumbed only when the model still sits above that
 * effective window.
 *
 * Settings isolation: HOME is redirected to a temp dir BEFORE the dist
 * imports (os.homedir() reads $HOME on POSIX), so no live settings.json is
 * read. The reader reads fresh on every call, so the fixture writes
 * settings.json between phases.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate settings: temp home without settings.json. MUST precede imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "compaction-reserve-"));
process.env.HOME = FAKE_HOME;
const SETTINGS_PATH = join(FAKE_HOME, ".pi", "agent", "settings.json");
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

const {
  MIN_COMPACTION_RESERVE_TOKENS,
  resolveCompactionReserveTokens,
  getConfiguredCompactionReserveTokens,
  applyCompactionReserveTokens,
} = await import("../../../dist/lib/config/braid-settings.js");
const { USAGE_WHISPER_WARNING, USAGE_WHISPER_CRITICAL, USAGE_COMPACT_MEDIUM } = await import(
  "../../../dist/lib/detection/context-thresholds.js"
);

console.log("=== compaction reserve derivation ===\n");

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

function derive(window) {
  const d = resolveCompactionReserveTokens(window);
  assert.ok(d, `expected a derivation for window ${String(window)}`);
  return d;
}

// ── A. the 75/25 split ─────────────────────────────────────────────────

await test("196000-token window derives 49000 reserve / 147000 trigger / 75.0%", () => {
  const d = derive(196_000);
  assert.equal(d.reserveTokens, 49_000);
  assert.equal(d.triggerTokens, 147_000);
  assert.equal(d.triggerPercent, 75);
});

await test("the split holds across windows (128k, 256k, 1M)", () => {
  const cases = [
    [128_000, 32_000, 96_000],
    [256_000, 64_000, 192_000],
    [1_048_576, 262_144, 786_432],
  ];
  for (const [window, reserve, trigger] of cases) {
    const d = derive(window);
    assert.equal(d.reserveTokens, reserve, `reserve for ${window}`);
    assert.equal(d.triggerTokens, trigger, `trigger for ${window}`);
    assert.equal(d.triggerPercent, 75, `percent for ${window}`);
  }
});

await test("reserve is exactly a quarter of the window and the trigger is the remainder", () => {
  const d = derive(196_000);
  assert.equal(d.reserveTokens, 196_000 / 4);
  assert.equal(d.reserveTokens + d.triggerTokens, 196_000);
});

await test("derivation is pure: same input, same output, no settings read", () => {
  assert.deepEqual(resolveCompactionReserveTokens(196_000), resolveCompactionReserveTokens(196_000));
});

// ── B. the floor ───────────────────────────────────────────────────────

await test("floor: pi-core's own default reserve is never undercut", () => {
  assert.equal(MIN_COMPACTION_RESERVE_TOKENS, 16_384);
  const d = derive(40_000); // 25% would be 10000 - thinner than pi-core's default
  assert.equal(d.reserveTokens, MIN_COMPACTION_RESERVE_TOKENS);
  assert.equal(d.triggerTokens, 40_000 - MIN_COMPACTION_RESERVE_TOKENS);
  assert.ok(
    d.triggerPercent < USAGE_WHISPER_WARNING,
    "the floor intentionally fires the trigger earlier than the band target",
  );
});

await test("floor boundary: 65536 is the smallest window whose quarter equals the floor", () => {
  assert.equal(derive(65_536).reserveTokens, MIN_COMPACTION_RESERVE_TOKENS);
  assert.equal(derive(65_536).triggerPercent, 75);
  assert.equal(derive(65_537).reserveTokens, MIN_COMPACTION_RESERVE_TOKENS);
});

// ── C. refusal ─────────────────────────────────────────────────────────

await test("invalid windows derive nothing", () => {
  for (const window of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "196000"]) {
    assert.equal(
      resolveCompactionReserveTokens(window),
      undefined,
      `window ${String(window)} must not derive`,
    );
  }
});

await test("a window the floor consumes entirely derives nothing", () => {
  assert.equal(resolveCompactionReserveTokens(16_384), undefined);
  const d = resolveCompactionReserveTokens(20_000);
  assert.equal(d.reserveTokens, MIN_COMPACTION_RESERVE_TOKENS);
  assert.ok(d.triggerTokens > 0, "a window above the floor keeps room to compact into");
});

// ── D. band containment ────────────────────────────────────────────────

await test("every derivation with room sits inside the usage band", () => {
  assert.equal(USAGE_WHISPER_WARNING, 65);
  assert.equal(USAGE_WHISPER_CRITICAL, 75);
  assert.equal(USAGE_COMPACT_MEDIUM, 80);
  for (const window of [65_536, 100_000, 128_000, 196_000, 256_000, 1_048_576]) {
    const d = derive(window);
    assert.ok(
      d.triggerPercent > USAGE_WHISPER_WARNING && d.triggerPercent < USAGE_COMPACT_MEDIUM,
      `${window}: ${d.triggerPercent}% must stay inside the band`,
    );
  }
});

// ── E. configured reserve resolution (what the owner's file says) ──────

await test("configured reserve: ordinary setting, then per-model override, invalid ignored", () => {
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      compaction: {
        reserveTokens: 49_152,
        modelOverrides: { "agent-zero/special": { reserveTokens: 60_000 } },
      },
    }),
  );
  assert.equal(getConfiguredCompactionReserveTokens("agent-zero", "special"), 60_000);
  assert.equal(getConfiguredCompactionReserveTokens("agent-zero", "ordinary"), 49_152);
  assert.equal(getConfiguredCompactionReserveTokens(), 49_152);
  writeFileSync(SETTINGS_PATH, JSON.stringify({ compaction: { reserveTokens: -1 } }));
  assert.equal(getConfiguredCompactionReserveTokens("agent-zero", "ordinary"), undefined);
  writeFileSync(SETTINGS_PATH, JSON.stringify({}));
  assert.equal(getConfiguredCompactionReserveTokens("agent-zero", "ordinary"), undefined);
});

// ── F. the effective (ceiling) window drives the derivation ────────────
// The plumb writes min(cap, true window) and leaves a model already at its
// true window untouched; the applier must resolve that same effective window.
// A raw-cap read sizes the reserve against a window pi-core never sees
// whenever the cap sits above the true window - a reserve larger than the
// window itself, so pi-core's threshold can never fire.

await test("ceiling binds: the derivation runs on the effective window, not the raw cap", () => {
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ braid: { context: { contextLimitTokens: 1_000_000 } } }),
  );
  const ctx = { model: { provider: "agent-zero", id: "true-window", contextWindow: 202_752 } };
  const result = applyCompactionReserveTokens(ctx);
  assert.notEqual(
    result.reason,
    "window-not-plumbed",
    "the model sits at its true window (the plumb keeps it), so the applier must derive",
  );
  assert.equal(result.reserveTokens, 50_688, "202752 - round(202752 * 0.75)");
  assert.equal(result.triggerTokens, 152_064);
  assert.equal(result.triggerPercent, 75);
});

await test("a model still above the effective cap is reported un-plumbed", () => {
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ braid: { context: { contextLimitTokens: 100_000 } } }),
  );
  const ctx = { model: { provider: "agent-zero", id: "true-window", contextWindow: 202_752 } };
  const result = applyCompactionReserveTokens(ctx);
  assert.equal(result.reason, "window-not-plumbed");
  assert.equal(result.reserveTokens, 25_000, "effective window 100000 - round(100000 * 0.75)");
  assert.equal(result.triggerTokens, 75_000);
});

await test("a model sitting at the effective cap derives on that cap", () => {
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ braid: { context: { contextLimitTokens: 100_000 } } }),
  );
  const ctx = { model: { provider: "agent-zero", id: "capped", contextWindow: 100_000 } };
  const result = applyCompactionReserveTokens(ctx);
  assert.notEqual(result.reason, "window-not-plumbed");
  assert.equal(result.reserveTokens, 25_000);
  assert.equal(result.triggerTokens, 75_000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
