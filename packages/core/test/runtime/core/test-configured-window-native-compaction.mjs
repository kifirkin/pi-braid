/**
 * Native threshold compaction uses the configured window (R1).
 *
 * braid.context.contextLimitTokens must reach pi-core's OWN compaction
 * decision: `_compactBeforeNextAssistantResponse` calls
 * `shouldCompact(estimateContextTokens(messages).tokens, model.contextWindow,
 * settings)`, and `model.contextWindow` is the live `agent.state.model`
 * object the extension context exposes. The polyfill's before_agent_start
 * hooks `applyConfiguredContextWindow` there, so after the plumb pi-core's
 * threshold check — composed here with the REAL pi-core shouldCompact +
 * estimateContextTokens + default reserveTokens — fires before the
 * configured cap. When the setting is unset the plumb is a no-op and
 * provider-window semantics hold (fallback invariant).
 *
 * Old behavior (regression guarded here): pi-core computed against the
 * provider window (1M), so with a 128k configured cap nothing automatic ever
 * fired (forensics V2: the composed system had no actor). Demonstrated red
 * against the pre-fix installed build (0.3.2-main.17), which lacks the
 * plumb entirely.
 *
 * Second half (reserve coherence): pi-core's threshold check is
 * `contextTokens > window - reserveTokens`, so the plumbed window alone
 * re-anchors the trigger to pi-core's independent reserve (a fixed token
 * count). The reserve scenarios below show the defect on pi-core's own math
 * (a 98304 reserve on a 196000 window fires at 49.8%) and the derived split
 * doing its job through pi-core's own reader (49000 -> trigger 147000,
 * exactly 75.0%).
 *
 * Run: node test/runtime/core/test-configured-window-native-compaction.mjs
 * DIST=<root> to test a specific build (default: this repo's dist).
 * DIST=<installed pi-braid>/dist re-runs the reserve scenarios against the
 * pre-fix build: they fail there, which is the failing-first evidence.
 */

import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file is imported TWICE (red run and green run) via runScenario().
// The module-level process.env.HOME must be set before the dist's
// braid-settings module evaluates SETTINGS_PATH — done inside runScenario
// before its dynamic imports.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIST = join(HERE, "..", "..", "..", "dist");
const INSTALLED_DIST = join(
  homedir(),
  ".pi/agent/local-packages/node_modules/pi-braid/node_modules/@earendil-works/pi-coding-agent",
);
void INSTALLED_DIST;
// The previously installed braid build. Run the fixture with DIST set to its
// `dist` dir to watch the reserve scenarios fail on the pre-fix code (same
// version string, no derivation) - the failing-first evidence for this file.
const PRE_FIX_BRAID_DIST = join(homedir(), ".pi/agent/local-packages/node_modules/pi-braid/dist");
void PRE_FIX_BRAID_DIST;
// DIST=<root> re-points every dist import (default: this repo's build).
const DIST_ROOT = process.env.DIST ?? REPO_DIST;

// Real pi-core compaction math (the decision the plumb must steer). Direct
// file URL: the package's exports map blocks subpath imports. The devDep
// hoists to the workspace root's node_modules.
const { shouldCompact, estimateContextTokens } = await import(
  "file://" +
    join(
      HERE,
      "../../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/index.js",
    )
);

// Real pi-core settings manager: the object pi-core's compaction reader walks
// (getCompactionReserveTokens -> settings.compaction, modelOverrides first).
const { SettingsManager } = await import(
  "file://" +
    join(
      HERE,
      "../../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js",
    )
);

// One fake HOME for the whole process: the dist's braid-settings pins
// SETTINGS_PATH when the module first evaluates, so every scenario rewrites
// that one file (readSettings() is uncached - a fresh read per call).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "configured-window-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
process.on("exit", () => rmSync(FAKE_HOME, { recursive: true, force: true }));

/** Write the settings.json the dist braid-settings module reads. */
function writeSettings(settings) {
  writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), JSON.stringify(settings));
}

console.log("=== configured window reaches native threshold compaction ===\n");

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

const CONFIGURED = 128_000;
const PROVIDER = 1_000_000;
const RESERVE_TOKENS = 32_768;

/** ~100k tokens of messages: above the configured threshold (128k - 32,768 = 95,232),
 * miles below the provider-window threshold (~967k). */
function makeMessages() {
  // estimateTokens: ceil(chars/4) for user text.
  const text = "x".repeat(100_000 * 4);
  return [{ role: "user", content: [{ type: "text", text }] }];
}

/**
 * Compose the exact decision pi-core's threshold path makes, against the
 * model object the named dist's plumb has (or has not) configured.
 */
async function runScenario(
  distRoot,
  { withConfiguredLimit, configured = CONFIGURED, providerWindow = PROVIDER },
) {
  writeSettings(
    withConfiguredLimit ? { braid: { context: { contextLimitTokens: configured } } } : {},
  );
  const settings = await import(join(distRoot, "lib/config/braid-settings.js"));
  const model = { contextWindow: providerWindow };
  const ctx = { model };
  if (typeof settings.applyConfiguredContextWindow === "function") {
    settings.applyConfiguredContextWindow(ctx);
  } else {
    // Pre-fix build (0.3.2-main.17): the plumb does not exist; the
    // configured window never reaches the model (this is the failure
    // under test).
  }
  const decision = shouldCompact(
    estimateContextTokens(makeMessages()).tokens,
    ctx.model.contextWindow,
    { enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 20_000 },
  );
  return { decision, effectiveWindow: ctx.model.contextWindow };
}

await test("configured 128k window: native threshold compaction fires at ~100k (provider 1M would never fire)", async () => {
  const { decision, effectiveWindow } = await runScenario(DIST_ROOT, {
    withConfiguredLimit: true,
  });
  assert.equal(
    effectiveWindow,
    CONFIGURED,
    "the plumb made the session model report the configured window",
  );
  assert.equal(
    decision,
    true,
    `pi-core shouldCompact must fire at ~100k tokens against the 128k configured window ` +
      `(threshold ${CONFIGURED - RESERVE_TOKENS}); provider-window semantics would never fire`,
  );
});

await test("unset contextLimitTokens: plumb is a no-op, provider-window semantics preserved", async () => {
  const { decision, effectiveWindow } = await runScenario(DIST_ROOT, {
    withConfiguredLimit: false,
  });
  assert.equal(
    effectiveWindow,
    PROVIDER,
    "no configured limit: the model keeps the provider window",
  );
  assert.equal(
    decision,
    false,
    "no compaction at ~90k against the 1M provider window (fallback holds)",
  );
});

// The ceiling case: a manual pick whose true window (202752) is below the
// configured cap (1M) must keep its true window, so pi-core's native math
// runs against 202752. Pre-change the blind overwrite widened the model to
// 1M: the RED assertion is effectiveWindow below; the composed shouldCompact
// rows show the behavioral difference at 180k tokens.
await test("ceiling: configured 1M above a 202752 true window keeps it; native math uses it", async () => {
  const TRUE_WINDOW = 202_752;
  const { effectiveWindow } = await runScenario(DIST_ROOT, {
    withConfiguredLimit: true,
    configured: PROVIDER,
    providerWindow: TRUE_WINDOW,
  });
  assert.equal(
    effectiveWindow,
    TRUE_WINDOW,
    "the plumb is a ceiling: configured 1M must not widen the 202752 true window",
  );
  const compaction = { enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 20_000 };
  const tokens = 180_000; // above 202752 − 32768 = 169984, below 1M − 32768
  assert.equal(
    shouldCompact(tokens, effectiveWindow, compaction),
    true,
    "pi-core's threshold fires at 180k against the 202752 ceiling window",
  );
  assert.equal(
    shouldCompact(tokens, PROVIDER, compaction),
    false,
    "and would not fire against the configured 1M cap the model must never report",
  );
});

// ── compaction reserve coherence (the plumb's second half) ─────────────
//
// pi-core's threshold check is `contextTokens > window - reserveTokens`: a
// fixed reserve re-anchors the trigger to an arbitrary percent of whatever
// window is plumbed in. These scenarios read the reserve back through
// pi-core's OWN SettingsManager reader and compose pi-core's OWN
// shouldCompact, so the numbers are pi-core's, not a re-implementation.

const WINDOW = 196_000;
const DERIVED_RESERVE = 49_000; // window - round(window * 75/100)
const DERIVED_TRIGGER = 147_000;
const INCOHERENT_RESERVE = 98_304; // half the window: trigger at 49.8%
const OWNER_RESERVE = 49_152; // 74.9% - inside the band, still not the split
const COHERENCE_MODEL = { provider: "agent-zero", id: "test-model", contextWindow: WINDOW };

const { USAGE_WHISPER_WARNING, USAGE_COMPACT_MEDIUM } = await import(
  join(DIST_ROOT, "lib/detection/context-thresholds.js")
);
const { getLogBuffer, clearLogBuffer } = await import(join(DIST_ROOT, "lib/core/logger.js"));

/** Real pi-core SettingsManager seeded with a reserve, passed as ctx.sessionManager. */
function makeSettingsManager(reserveTokens) {
  return SettingsManager.inMemory({ compaction: { reserveTokens } });
}

/** The live ctx shape the polyfill plumb sees, with a real settings handle. */
function makeCtx(sessionManager) {
  return { model: { ...COHERENCE_MODEL }, sessionManager };
}

function warnEntries(match) {
  return getLogBuffer().filter(
    (e) => e.source === "braid-settings" && e.level === "warn" && e.message.includes(match),
  );
}

function pct(tokens) {
  return ((tokens / WINDOW) * 100).toFixed(1);
}

await test("a session handle with no settings object: unreachable, warned once, value spelled out", async () => {
  writeSettings({
    braid: { context: { contextLimitTokens: WINDOW } },
    compaction: { reserveTokens: OWNER_RESERVE },
  });
  const settings = await import(join(DIST_ROOT, "lib/config/braid-settings.js"));
  // The session-tree handle pi-core hands to extensions carries no settings
  // object; there is no writable handle, and the owner needs the value.
  const sessionManager = {
    getSessionId: () => "s",
    getSessionFile: () => null,
    getLeafId: () => null,
  };
  const ctx = { model: { ...COHERENCE_MODEL }, sessionManager };
  clearLogBuffer();
  const first = settings.applyCompactionReserveTokens?.(ctx);
  const second = settings.applyCompactionReserveTokens?.(ctx);
  assert.equal(first?.reason, "unreachable");
  assert.equal(second?.reason, "unreachable");
  assert.equal(first?.reserveTokens, DERIVED_RESERVE);
  const warnings = warnEntries("cannot be re-anchored");
  assert.equal(warnings.length, 1, "exactly one warning across two calls");
  assert.ok(
    warnings[0].message.includes(`compaction.reserveTokens = ${DERIVED_RESERVE}`),
    warnings[0].message,
  );
  assert.ok(
    warnings[0].message.includes(String(WINDOW - OWNER_RESERVE)),
    `names the configured trigger (${WINDOW - OWNER_RESERVE}): ${warnings[0].message}`,
  );
});

await test(
  `incoherent reserve ${INCOHERENT_RESERVE} fires compaction at 49.8%; the derived ${DERIVED_RESERVE} (75.0%) cannot be written from an extension`,
  async () => {
    writeSettings({
      braid: { context: { contextLimitTokens: WINDOW } },
      compaction: { reserveTokens: INCOHERENT_RESERVE },
    });
    const settings = await import(join(DIST_ROOT, "lib/config/braid-settings.js"));
    const sm = makeSettingsManager(INCOHERENT_RESERVE);
    const ctx = makeCtx(sm);
    settings.applyConfiguredContextWindow(ctx);

    // The defect, on pi-core's own math: 98304 of 196000 fires at 97696.
    const defectiveTrigger = WINDOW - INCOHERENT_RESERVE;
    assert.equal(defectiveTrigger, 97_696);
    assert.equal(
      shouldCompact(defectiveTrigger, ctx.model.contextWindow, sm.getCompactionSettings(ctx.model)),
      false,
      "shouldCompact fires above the threshold, not at it",
    );
    assert.equal(
      shouldCompact(
        defectiveTrigger + 1,
        ctx.model.contextWindow,
        sm.getCompactionSettings(ctx.model),
      ),
      true,
      `the incoherent reserve fires at ${defectiveTrigger} tokens (${pct(defectiveTrigger)}%)`,
    );
    assert.ok(
      (defectiveTrigger / WINDOW) * 100 < USAGE_WHISPER_WARNING,
      `${pct(defectiveTrigger)}% is outside the ${USAGE_WHISPER_WARNING}-${USAGE_COMPACT_MEDIUM}% band`,
    );

    clearLogBuffer();
    const result = settings.applyCompactionReserveTokens?.(ctx);
    assert.equal(result?.reason, "unreachable");
    assert.equal(result?.reserveTokens, DERIVED_RESERVE);
    assert.equal(result?.triggerTokens, DERIVED_TRIGGER);
    assert.equal(result?.triggerPercent, 75);
    const effectiveReserve = sm.getCompactionReserveTokens(ctx.model);
    assert.equal(
      effectiveReserve,
      INCOHERENT_RESERVE,
      `the extension cannot re-anchor pi-core's reader: reserve stays ${effectiveReserve} ` +
        `(trigger ${WINDOW - effectiveReserve}); a write would have moved it to ${DERIVED_RESERVE}`,
    );
    assert.equal(
      sm.globalSettings.compaction.reserveTokens,
      INCOHERENT_RESERVE,
      "the settings object is untouched - no code path writes it",
    );
    const warnings = warnEntries(`Compaction reserve ${INCOHERENT_RESERVE} is incoherent`);
    assert.equal(warnings.length, 1, "one incoherence warning per process");
    assert.ok(warnings[0].message.includes(pct(defectiveTrigger)), warnings[0].message);
    assert.ok(warnings[0].message.includes(String(DERIVED_RESERVE)), warnings[0].message);
  },
);

await test(
  `owner-like reserve ${OWNER_RESERVE} (74.9%, inside the band) stays put without warning noise`,
  async () => {
    writeSettings({
      braid: { context: { contextLimitTokens: WINDOW } },
      compaction: { reserveTokens: OWNER_RESERVE },
    });
    const settings = await import(join(DIST_ROOT, "lib/config/braid-settings.js"));
    const sm = makeSettingsManager(OWNER_RESERVE);
    const ctx = makeCtx(sm);
    settings.applyConfiguredContextWindow(ctx);
    clearLogBuffer();
    const result = settings.applyCompactionReserveTokens?.(ctx);
    assert.equal(result?.reason, "unreachable");
    assert.equal(
      sm.getCompactionReserveTokens(ctx.model),
      OWNER_RESERVE,
      "no write: the owner's coherent reserve stays",
    );
    assert.equal(warnEntries("is incoherent").length, 0, "74.9% sits inside the band");
    assert.equal(
      warnEntries("cannot be re-anchored").length,
      0,
      "the once-per-process warning was already spent on the first applier call",
    );
  },
);

await test("a window the floor consumes: no derivation, one warning, pi-core defaults untouched", async () => {
  writeSettings({ braid: { context: { contextLimitTokens: 16_384 } } });
  const settings = await import(join(DIST_ROOT, "lib/config/braid-settings.js"));
  const sm = makeSettingsManager(OWNER_RESERVE);
  const ctx = makeCtx(sm);
  settings.applyConfiguredContextWindow(ctx);
  clearLogBuffer();
  const result = settings.applyCompactionReserveTokens?.(ctx);
  assert.equal(result?.reason, "no-derivation");
  assert.equal(sm.getCompactionReserveTokens(ctx.model), OWNER_RESERVE, "no write");
  assert.equal(warnEntries("leaves no room for a compaction reserve").length, 1);
});

await test("reserve follows the plumb: an unplumbed model (provider window) is left alone", async () => {
  writeSettings({
    braid: { context: { contextLimitTokens: WINDOW } },
    compaction: { reserveTokens: OWNER_RESERVE },
  });
  const settings = await import(join(DIST_ROOT, "lib/config/braid-settings.js"));
  const sm = makeSettingsManager(OWNER_RESERVE);
  const ctx = { model: { ...COHERENCE_MODEL, contextWindow: 1_000_000 }, sessionManager: sm };
  clearLogBuffer();
  const result = settings.applyCompactionReserveTokens?.(ctx);
  assert.equal(result?.reason, "window-not-plumbed");
  assert.equal(sm.getCompactionReserveTokens(ctx.model), OWNER_RESERVE, "no write without the window");
});

await test("unset contextLimitTokens: the reserve applier is a no-op", async () => {
  writeSettings({ compaction: { reserveTokens: OWNER_RESERVE } });
  const settings = await import(join(DIST_ROOT, "lib/config/braid-settings.js"));
  const sm = makeSettingsManager(OWNER_RESERVE);
  const ctx = makeCtx(sm);
  clearLogBuffer();
  const result = settings.applyCompactionReserveTokens?.(ctx);
  assert.equal(result?.reason, "unset");
  assert.equal(sm.getCompactionReserveTokens(ctx.model), OWNER_RESERVE);
  assert.equal(warnEntries("").length, 0, "silent when the cap is unset");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
