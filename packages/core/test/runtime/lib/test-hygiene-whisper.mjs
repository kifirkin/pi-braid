/**
 * Unit tests for the hygiene whisper pure formatter (no pi/ctx dependency),
 * repurposed as a once-per-session steer whisper carrying the
 * context-hygiene signal (tokens in context + tokens since last baseline).
 * Renamed from test-awareness-whisper.mjs; customType is "hygiene".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src", "extensions", "core", "prompt-builder", "awareness-whisper.ts");

const { formatAwarenessText } =
  await import("../../../dist/extensions/core/prompt-builder/awareness-whisper.js");
const {
  readTelegramPollerLiveness,
  setTelegramPollerLivenessProbe,
  resetTelegramPollerLivenessProbe,
} = await import("../../../dist/lib/state/telegram-poller-liveness.js");

describe("hygiene-whisper", () => {
  it("carries the context-hygiene signal: tokens in context", () => {
    const text = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 2,
      telegramInbound: "live",
    });
    assert.ok(text.startsWith("Hygiene:"));
    assert.match(text, /\b42K tokens in context\b/);
  });

  it("first emission reports the baseline being set (no delta yet)", () => {
    const text = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: null,
      contextToolCount: 2,
      telegramInbound: "live",
    });
    assert.match(text, /baseline set \(42K\)/);
    assert.match(text, /delta reported on a later session/);
    assert.ok(!text.includes("+"), "no delta marker on the baseline-setting emission");
  });

  it("later emissions report the delta since the last baseline", () => {
    const text = formatAwarenessText({
      tokensInContext: 52_224,
      tokensSinceBaseline: 9_216,
      contextToolCount: 2,
      telegramInbound: "live",
    });
    assert.match(text, /\b51K tokens in context\b/);
    assert.match(text, /\+9K since last baseline\b/);
  });

  it("clamps negative deltas to zero (compaction can shrink below baseline)", () => {
    const text = formatAwarenessText({
      tokensInContext: 10_240,
      tokensSinceBaseline: -5_000,
      contextToolCount: 2,
      telegramInbound: "live",
    });
    assert.match(text, /\+0K since last baseline\b/);
  });

  it("is summary + pointer + the reachability catalog (2 + 4 lines)", () => {
    const text = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 4,
      telegramInbound: "live",
    });
    const lines = text.split("\n");
    assert.equal(lines.length, 6, "2 hygiene lines + catalog header + 3 channels");
    assert.match(lines[0], /^Hygiene:/);
    assert.match(lines[2], /^Can reach you \(injection channels\):$/);
    // Subsystem whispers are described by the stable envelope, not
    // enumerated; the parenthetical example set names real subsystems and
    // claims no cadences (wiring for "real" is the producer test below).
    const catalog = lines.slice(2).join("\n");
    assert.match(catalog, /\[braid-whisper - <subsystem> @ <time>\]/);
    assert.match(catalog, /the tag names the sending subsystem/);
    assert.match(catalog, /\(e\.g\. enforcement, heartbeat, watchdog, timer, context-lifecycle\)/);
    assert.doesNotMatch(catalog, /per-turn|every ~|on expiry|on thresholds/);
    assert.match(catalog, /- TG inbound:/);
    assert.match(catalog, /- owner TUI input:/);
    assert.ok(
      catalog.length <= 560,
      `catalog ≤80 tokens (~7 chars/token): ${catalog.length} chars`,
    );
  });

  it("catalog example subsystems are real whisper producers (wiring)", () => {
    // Each example name must be the first segment of at least one static
    // `source:` tag in a src/ file that calls sendTrackedMessage (the
    // envelope is applied centrally there). Dynamic template sources are
    // not scanned - they cannot be enumerated statically. This keeps the
    // example set honest: a renamed or retired subsystem must be dropped
    // from the catalog, and a new one may be added only when it sends.
    const walk = (dir, acc = []) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (e.name.endsWith(".ts")) acc.push(p);
      }
      return acc;
    };
    const firstSegments = new Set();
    for (const file of walk(join(ROOT, "src"))) {
      const src = readFileSync(file, "utf-8");
      if (!src.includes("sendTrackedMessage")) continue;
      for (const m of src.matchAll(/source:\s*"([^"]+)"/g)) {
        firstSegments.add(m[1].split("/")[0]);
      }
    }
    const EXAMPLES = ["enforcement", "heartbeat", "watchdog", "timer", "context-lifecycle"];
    for (const name of EXAMPLES) {
      assert.ok(
        firstSegments.has(name),
        `catalog example "${name}" has no whisper producer in src/ (no static source: tag in a sendTrackedMessage caller)`,
      );
    }
  });

  it("contains no inline bracket sub-tags (envelope comes from runtime only)", () => {
    const text = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 3,
      telegramInbound: "live",
    });
    // The subsystem row names the envelope template and the owner-TUI row
    // names the bare envelope marker in prose; neither builds one. Strip
    // those two mentions before scanning for bracket sub-tags.
    const prose = text
      .replace("[braid-whisper - <subsystem> @ <time>]", "braid-whisper")
      .replace("[braid-whisper ...]", "braid-whisper");
    assert.doesNotMatch(prose, /\[[^\]]+\]/);
  });

  it("points at context tools only when context tools exist", () => {
    const withTools = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 3,
      telegramInbound: "live",
    });
    assert.ok(withTools.includes("context_inspect"));
    const withoutTools = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 0,
      telegramInbound: "live",
    });
    assert.ok(!withoutTools.includes("context_inspect"));
    assert.ok(withoutTools.includes("Inspect with system_info or memory recall on demand."));
  });

  it("source keeps the renamed customType", () => {
    const src = readFileSync(SRC, "utf-8");
    assert.ok(src.includes('customType: "hygiene"'), 'whisper must emit customType "hygiene"');
    assert.ok(!src.includes('customType: "awareness"'), 'old customType "awareness" must be gone');
  });
});

describe("hygiene-whisper TG row gating ", () => {
  const LIVE_PIN = [
    "Hygiene: 42K tokens in context; +0K since last baseline.",
    "Inspect with system_info, memory recall, or context_inspect.",
    "Can reach you (injection channels):",
    "- subsystem whispers arrive in [braid-whisper - <subsystem> @ <time>] envelopes — the tag names the sending subsystem (e.g. enforcement, heartbeat, watchdog, timer, context-lifecycle)",
    "- TG inbound: owner Telegram messages, on arrival — reply via telegram_send",
    "- owner TUI input: a message with no [braid-whisper ...] envelope — answer in-session",
  ].join("\n");

  it("known-live state keeps today's row byte-identical (regression pin)", () => {
    const text = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 2,
      telegramInbound: "live",
    });
    assert.equal(text, LIVE_PIN);
  });

  it("known-not-live state hedges and names the check (no reachability claim)", () => {
    const text = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 2,
      telegramInbound: "off",
    });
    const row = text.split("\n").find((l) => l.startsWith("- TG inbound:"));
    assert.equal(
      row,
      "- TG inbound: owner Telegram messages, poller not running (telegram_poller status) — reply via telegram_send",
    );
    assert.ok(!text.includes("on arrival"), "hedged row must not assert arrival");
  });

  it("unknown state hedges and names the check (no reachability claim)", () => {
    const text = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 2,
      telegramInbound: "unknown",
    });
    const row = text.split("\n").find((l) => l.startsWith("- TG inbound:"));
    assert.equal(
      row,
      "- TG inbound: owner Telegram messages, reachability unverified (telegram_poller status) — reply via telegram_send",
    );
    assert.ok(!text.includes("on arrival"), "hedged row must not assert arrival");
  });

  it("catalog stays within the 80-token budget in every state", () => {
    for (const telegramInbound of ["live", "off", "unknown"]) {
      const text = formatAwarenessText({
        tokensInContext: 43_008,
        tokensSinceBaseline: 0,
        contextToolCount: 2,
        telegramInbound,
      });
      const catalog = text.split("\n").slice(2).join("\n");
      assert.ok(
        catalog.length <= 560,
        `catalog ≤80 tokens (~7 chars/token) in state ${telegramInbound}: ${catalog.length} chars`,
      );
    }
  });

  it("missing field fails safe to the hedged row (never asserts reachability)", () => {
    const text = formatAwarenessText({
      tokensInContext: 43_008,
      tokensSinceBaseline: 0,
      contextToolCount: 2,
      telegramInbound: undefined,
    });
    assert.ok(text.includes("reachability unverified"), "undefined state hedges");
  });
});

describe("telegram-poller-liveness registry", () => {
  it("reads unknown when no probe was published", () => {
    resetTelegramPollerLivenessProbe();
    assert.equal(readTelegramPollerLiveness(), "unknown");
  });

  it("reads running when the published probe returns true", () => {
    resetTelegramPollerLivenessProbe();
    setTelegramPollerLivenessProbe(() => true);
    assert.equal(readTelegramPollerLiveness(), "running");
  });

  it("reads stopped when the published probe returns false", () => {
    resetTelegramPollerLivenessProbe();
    setTelegramPollerLivenessProbe(() => false);
    assert.equal(readTelegramPollerLiveness(), "stopped");
  });

  it("reflects the probe live on every read (silent-death coverage)", () => {
    resetTelegramPollerLivenessProbe();
    let running = true;
    setTelegramPollerLivenessProbe(() => running);
    assert.equal(readTelegramPollerLiveness(), "running");
    running = false; // poller dies without anyone re-publishing
    assert.equal(readTelegramPollerLiveness(), "stopped");
  });

  it("degrades a throwing probe to unknown (whisper path never throws)", () => {
    resetTelegramPollerLivenessProbe();
    setTelegramPollerLivenessProbe(() => {
      throw new Error("boom");
    });
    assert.equal(readTelegramPollerLiveness(), "unknown");
  });

  it("reset clears the slot", () => {
    setTelegramPollerLivenessProbe(() => true);
    assert.equal(readTelegramPollerLiveness(), "running");
    resetTelegramPollerLivenessProbe();
    assert.equal(readTelegramPollerLiveness(), "unknown");
  });

  it("slot literal stays in sync between core and telegram (drift guard)", () => {
    const coreSrc = readFileSync(
      join(ROOT, "src", "lib", "state", "telegram-poller-liveness.ts"),
      "utf-8",
    );
    const tgSrc = readFileSync(join(ROOT, "..", "telegram", "src", "index.ts"), "utf-8");
    const LITERAL = "__braid_tg_poller_liveness";
    assert.ok(coreSrc.includes(LITERAL), "core registry carries the slot literal");
    assert.ok(tgSrc.includes(LITERAL), "telegram publisher carries the same literal");
  });
});

console.log("[ok] Hygiene whisper tests complete");
