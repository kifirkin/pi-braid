/**
 * notify.test.mjs — turn-complete auto-notify (item 20), deterministic.
 *
 * NO network, NO real LLM: the crafting model call and delivery are injected.
 * Covers:
 *  - shouldNotifyTurnEnd / extractFinalText / truncateGuard / prompts
 *  - sliding-window rate limiter (explicit timestamps)
 *  - turn_end handler: crafting fires on a plain-text answer, NOT on a
 *    trailing tool call; guard-fallback when the model fails; rate limiting;
 *    delivered text carries NO [tg-end] marker
 *  - key-ring-backed model resolver: the API key comes from the registry
 *    (providers key-ring), never the bot token
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldNotifyTurnEnd,
  extractFinalText,
  buildNotifyPrompts,
  buildRichSummaryPrompts,
  truncateGuard,
} from "../dist/lib/notify/craft.js";
import { DEFAULT_NOTIFY_MAX_CHARS } from "../dist/lib/telegram-settings.js";
import { SlidingWindowLimiter } from "../dist/lib/notify/rate-limit.js";
import {
  createTurnNotifyHandler,
  DEFAULT_NOTIFY_MAX_PER_MIN,
} from "../dist/lib/notify/turn-notify.js";
import {
  resolveNotifyModel,
  callCraftModel,
  createTextCraftHook,
  craftMaxTokensFor,
  DEFAULT_CRAFT_MAX_TOKENS,
} from "../dist/lib/notify/model.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const plainAnswerEvent = {
  type: "turn_end",
  turnIndex: 3,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "The fix is deployed to prod." }],
    stopReason: "stop",
  },
  toolResults: [],
};

const trailingToolEvent = {
  type: "turn_end",
  turnIndex: 2,
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Let me check the logs first." },
      { type: "toolCall", id: "t1", name: "grep", arguments: {} },
    ],
    stopReason: "toolUse",
  },
  toolResults: [],
};

const userMessageEvent = {
  type: "turn_end",
  turnIndex: 1,
  message: { role: "user", content: "hello", timestamp: 1 },
  toolResults: [],
};

const emptyTextEvent = {
  type: "turn_end",
  turnIndex: 4,
  message: { role: "assistant", content: [], stopReason: "stop" },
  toolResults: [],
};

const fakeModel = {
  id: "openrouter/venice-mini",
  provider: "openrouter",
  api: "openai-completions",
  baseUrl: "x",
  input: [],
};
const fakeRegistry = {
  keySource: "key-ring",
  getApiKeyForProvider: async () => "RING-KEY-123",
  find: () => fakeModel,
  getAll: () => [fakeModel],
  getAvailable: () => [fakeModel],
};

// ── craft.ts ────────────────────────────────────────────────────────────────

test("shouldNotifyTurnEnd: true for a completed plain-text answer turn", () => {
  assert.equal(shouldNotifyTurnEnd(plainAnswerEvent), true);
});

test("shouldNotifyTurnEnd: false when the last action was a trailing tool call", () => {
  assert.equal(shouldNotifyTurnEnd(trailingToolEvent), false);
});

test("shouldNotifyTurnEnd: false for non-assistant / empty-text turns", () => {
  assert.equal(shouldNotifyTurnEnd(userMessageEvent), false);
  assert.equal(shouldNotifyTurnEnd(emptyTextEvent), false);
  assert.equal(shouldNotifyTurnEnd(undefined), false);
  assert.equal(shouldNotifyTurnEnd({}), false);
});

test("extractFinalText: concatenates the assistant's text content only", () => {
  assert.equal(
    extractFinalText(plainAnswerEvent),
    "The fix is deployed to prod.",
  );
  assert.equal(
    extractFinalText(trailingToolEvent),
    "Let me check the logs first.",
  );
  assert.equal(extractFinalText(emptyTextEvent), "");
});

test("buildNotifyPrompts: embeds the final text and the configured cap", () => {
  const { system, user } = buildNotifyPrompts("The fix is deployed to prod.");
  assert.ok(system.includes(String(DEFAULT_NOTIFY_MAX_CHARS)));
  assert.ok(user.includes("The fix is deployed to prod."));
  // The cap is injected, not hardcoded: an explicit cap lands in the prompt.
  const custom = buildNotifyPrompts("x", 500);
  assert.ok(custom.system.includes("500"));
});

test("buildRichSummaryPrompts: threads the chosen format into the prompt (Task C)", () => {
  const md = buildRichSummaryPrompts("x", "Markdown");
  assert.ok(
    md.system.includes("**bold**"),
    "markdown prompt asks for markdown",
  );
  assert.ok(md.system.includes("no raw HTML"), "markdown prompt forbids HTML");
  const html = buildRichSummaryPrompts("x", "HTML");
  assert.ok(html.system.includes("<b>"), "HTML prompt asks for HTML tags");
  assert.match(html.system, /raw Markdown/i, "HTML prompt forbids markdown");
  assert.ok(
    !html.system.includes("**bold**"),
    "HTML prompt must not ask for markdown",
  );
  // Default stays Markdown — the historical live-update behavior.
  assert.equal(buildRichSummaryPrompts("x").system, md.system);
});

test("truncateGuard: leaves ≤ cap untouched, truncates > cap with an ellipsis", () => {
  assert.equal(truncateGuard("short"), "short");
  const long = "a".repeat(DEFAULT_NOTIFY_MAX_CHARS + 50);
  const r = truncateGuard(long);
  assert.equal(r.length, DEFAULT_NOTIFY_MAX_CHARS);
  assert.ok(r.endsWith("…"));
  // Explicit cap (tests/config seam) is honored too.
  const short200 = truncateGuard("a".repeat(250), 200);
  assert.equal(short200.length, 200);
});

// ── rate-limit.ts ───────────────────────────────────────────────────────────

test("SlidingWindowLimiter: allows up to N per window, blocks after, resets", () => {
  const limiter = new SlidingWindowLimiter({
    maxPerWindow: 2,
    windowMs: 60_000,
  });
  assert.equal(limiter.try(0), true);
  assert.equal(limiter.try(1), true);
  assert.equal(
    limiter.try(2),
    false,
    "third hit inside the window must be blocked",
  );
  assert.equal(limiter.try(60_001), true, "window slid — slot freed");
  limiter.reset();
  assert.equal(limiter.try(100), true);
});

// ── turn-notify handler ─────────────────────────────────────────────────────

test("turn_end: crafting fires on a plain-text answer and delivers the crafted text (no [tg-end])", async () => {
  const delivered = [];
  const modelCalls = [];
  const handler = createTurnNotifyHandler({
    callModel: async (prompts, modelCtx) => {
      modelCalls.push({ prompts, modelCtx });
      return { ok: true, text: "Deployed the fix." };
    },
    deliver: async (text) => delivered.push(text),
  });
  const outcome = await handler(plainAnswerEvent, {
    registry: fakeRegistry,
    sessionModel: fakeModel,
  });
  assert.equal(outcome.notified, true);
  assert.equal(outcome.text, "Deployed the fix.");
  assert.equal(
    modelCalls.length,
    1,
    "crafting model must be called exactly once",
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0], "Deployed the fix.");
  assert.ok(
    !delivered[0].includes("[tg-end]"),
    "outbound must NOT carry the inbound-only [tg-end] marker",
  );
});

test("turn_end: NO crafting and NO delivery when the last action was a trailing tool call", async () => {
  const delivered = [];
  const modelCalls = [];
  const handler = createTurnNotifyHandler({
    callModel: async () => {
      modelCalls.push(1);
      return { ok: true, text: "x" };
    },
    deliver: async (text) => delivered.push(text),
  });
  const outcome = await handler(trailingToolEvent, {
    registry: fakeRegistry,
    sessionModel: fakeModel,
  });
  assert.equal(outcome.notified, false);
  assert.equal(
    modelCalls.length,
    0,
    "no crafting when the turn ends on a tool call",
  );
  assert.equal(delivered.length, 0);
});

test("turn_end: guard-truncation fallback delivers the raw answer when the crafting model fails", async () => {
  const delivered = [];
  const handler = createTurnNotifyHandler({
    callModel: async () => ({ ok: false, error: "rate limited" }),
    deliver: async (text) => delivered.push(text),
  });
  const outcome = await handler(plainAnswerEvent, {
    registry: fakeRegistry,
    sessionModel: fakeModel,
  });
  assert.equal(outcome.notified, true);
  assert.equal(delivered[0], "The fix is deployed to prod.");
  assert.ok(!delivered[0].includes("[tg-end]"));
});

test("turn_end: maxLength override drives the prompt cap, the token budget and the guard", async () => {
  const delivered = [];
  const seen = [];
  const longAnswerEvent = {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "z".repeat(400) }],
      stopReason: "stop",
    },
    toolResults: [],
  };
  const handler = createTurnNotifyHandler({
    maxLength: 300,
    callModel: async (prompts, _modelCtx, opts) => {
      seen.push({ prompts, opts });
      return { ok: false, error: "model down" }; // force the guard fallback
    },
    deliver: async (text) => delivered.push(text),
  });
  const outcome = await handler(longAnswerEvent, {
    registry: fakeRegistry,
    sessionModel: fakeModel,
  });
  assert.equal(outcome.notified, true);
  assert.ok(seen[0].prompts.system.includes("300"));
  assert.equal(seen[0].opts.maxTokens, craftMaxTokensFor(300));
  assert.equal(delivered[0].length, 300);
  assert.ok(delivered[0].endsWith("…"));
});

test("turn_end: rate limiter blocks notifications beyond max-per-minute", async () => {
  const delivered = [];
  const handler = createTurnNotifyHandler({
    callModel: async () => ({ ok: true, text: "update" }),
    deliver: async (text) => delivered.push(text),
    maxPerWindow: 2,
    windowMs: 60_000,
    now: () => 1000,
  });
  const first = await handler(plainAnswerEvent, {
    registry: fakeRegistry,
    sessionModel: fakeModel,
  });
  const second = await handler(plainAnswerEvent, {
    registry: fakeRegistry,
    sessionModel: fakeModel,
  });
  const third = await handler(plainAnswerEvent, {
    registry: fakeRegistry,
    sessionModel: fakeModel,
  });
  assert.equal(first.notified, true);
  assert.equal(second.notified, true);
  assert.equal(third.notified, false);
  assert.equal(third.skipped, "rate-limited");
  assert.equal(delivered.length, 2);
});

test("turn_end: never throws — a throwing delivery is swallowed", async () => {
  const handler = createTurnNotifyHandler({
    callModel: async () => ({ ok: true, text: "update" }),
    deliver: async () => {
      throw new Error("network down");
    },
  });
  const outcome = await handler(plainAnswerEvent, {
    registry: fakeRegistry,
    sessionModel: fakeModel,
  });
  assert.equal(outcome.notified, false);
});

// ── model.ts — key-ring-backed resolver ─────────────────────────────────────

test("resolveNotifyModel: env override wins, then session model, then first available", () => {
  const reg = {
    find: (p, m) =>
      p === "openrouter" && m === "custom"
        ? { ...fakeModel, id: "openrouter/custom" }
        : undefined,
    getAll: () => [fakeModel],
    getAvailable: () => [fakeModel],
  };
  assert.equal(
    resolveNotifyModel(reg, undefined, "openrouter/custom").id,
    "openrouter/custom",
  );
  assert.equal(resolveNotifyModel(reg, fakeModel, undefined), fakeModel);
  assert.equal(resolveNotifyModel(reg, undefined, undefined), fakeModel);
});

test("callCraftModel: the API key comes from the registry (key-ring), not the bot token", async () => {
  let seenApiKey;
  const completeSimpleFn = async (_model, _ctx, opts) => {
    seenApiKey = opts.apiKey;
    return {
      content: [{ type: "text", text: "crafted update" }],
      stopReason: "stop",
    };
  };
  const result = await callCraftModel(
    fakeRegistry,
    fakeModel,
    { system: "s", user: "u" },
    { completeSimpleFn },
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "crafted update");
  assert.equal(
    seenApiKey,
    "RING-KEY-123",
    "key must come from the key-ring-backed registry",
  );
});

test("callCraftModel: surfaces a provider error as a non-throwing failure", async () => {
  const completeSimpleFn = async () => ({
    content: [],
    stopReason: "error",
    errorMessage: "403 quota",
  });
  const result = await callCraftModel(
    fakeRegistry,
    fakeModel,
    { system: "s", user: "u" },
    { completeSimpleFn },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /403 quota/);
});

test("createTextCraftHook: distills long text; returns null when the model call fails", async () => {
  const completeSimpleFn = async () => ({
    content: [{ type: "text", text: "done: fixed" }],
    stopReason: "stop",
  });
  const hook = createTextCraftHook(fakeRegistry, fakeModel, undefined, {
    completeSimpleFn,
  });
  const ok = await hook("a".repeat(500));
  assert.deepEqual(ok, { text: "done: fixed", crafted: true });
  const failHook = createTextCraftHook(fakeRegistry, fakeModel, undefined, {
    completeSimpleFn: async () => ({
      content: [],
      stopReason: "error",
      errorMessage: "boom",
    }),
  });
  assert.equal(await failHook("a".repeat(500)), null);
});

// ── defaults sanity ─────────────────────────────────────────────────────────

test("defaults: notify cap is 1200, max-per-minute policy is 4 (design decision surface)", () => {
  assert.equal(DEFAULT_NOTIFY_MAX_PER_MIN, 4);
  assert.equal(DEFAULT_NOTIFY_MAX_CHARS, 1200);
  // Bare craft calls keep their historical budget; the notify path scales it.
  assert.equal(DEFAULT_CRAFT_MAX_TOKENS, 200);
  assert.equal(craftMaxTokensFor(1200), 600);
  assert.equal(craftMaxTokensFor(50), 512); // floor
  assert.equal(craftMaxTokensFor(100_000), 4096); // ceiling
});
