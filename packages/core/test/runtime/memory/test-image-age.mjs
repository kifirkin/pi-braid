/**
 * Image age-out (braid.context.imageAge).
 *
 * The measured failure this rule ends: an image under the capture cap rides
 * in every request for the rest of the session. A seven-hour session reached
 * 385,152 tokens with 22 image blocks at 514,977 chars still in the prompt at
 * the last turn, and context_compress was never called.
 *
 * Behaviors pinned here:
 * A. Config resolver: absent -> enabled TRUE, turns 20; valid partial merge;
 *    invalid per-field -> default; non-object -> defaults; the getter reads
 *    live settings on every call.
 * B. Handler (registered on the per-request `context` event): an image older
 *    than the threshold becomes one text block naming its file and the tool
 *    that re-reads it, every other block is kept, the session's own array is
 *    never mutated, and the text is stable across requests.
 * C. The rule's safety leg: an image is never aged when the file is missing,
 *    empty, named by a relative path, or unnamed; an image younger than the
 *    threshold stays; the setting's off switch stops the pass.
 * D. The two per-request passes compose: in one returned array, an old image
 *    becomes a pointer and an old large text result becomes a flush stub.
 *
 * Settings + storage isolation: HOME redirected to a temp dir BEFORE the dist
 * imports (the capture-cap fixture's pattern).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Isolate settings AND offload storage: temp home. MUST precede imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "image-age-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
const SETTINGS_PATH = join(FAKE_HOME, ".pi", "agent", "settings.json");
function writeSettings(braid) {
  if (braid === null) {
    rmSync(SETTINGS_PATH, { force: true });
    return;
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify({ braid }));
}

const { resolveImageAgeConfig, getImageAgeConfig } = await import(
  "../../../dist/lib/config/braid-settings.js"
);
const { registerStaleToolResultOffloader } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/offload.js"
);
const { formatImagePolicyLine, getImagePolicyHealth, resetImagePolicyHealth } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/image-policy.js"
);

/** The registered per-request handler, as the harness would call it. */
function contextHandler() {
  const captured = [];
  registerStaleToolResultOffloader({ on: (type, fn) => captured.push({ type, fn }) });
  const handler = captured.find((h) => h.type === "context").fn;
  assert.ok(handler, "a context handler is registered");
  return handler;
}

const SOURCE_FILE = join(FAKE_HOME, "render.png");
writeFileSync(SOURCE_FILE, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

const IMAGE_DATA = "IMG".repeat(4000);
const IMAGE_RESULT = {
  role: "toolResult",
  toolCallId: "call_image",
  toolName: "read",
  content: [
    { type: "text", text: "decoded render.png" },
    { type: "image", data: IMAGE_DATA, mimeType: "image/png" },
  ],
};

function callFor(id, path) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
  };
}

/** `count` filler tool results after a lead section. */
function filler(count, tag = "f") {
  return Array.from({ length: count }, (_, i) => ({
    role: "toolResult",
    toolCallId: `${tag}${i}`,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
  }));
}

/** A session-shaped message array whose second result is an image. */
function transcript({ callPath = SOURCE_FILE, turnsAfter = 20, toolCallId = "call_image" } = {}) {
  const image = {
    ...IMAGE_RESULT,
    toolCallId,
    content: IMAGE_RESULT.content.map((block) => ({ ...block })),
  };
  return [
    { role: "user", content: [{ type: "text", text: "look at the render" }] },
    callFor(toolCallId, callPath),
    image,
    ...filler(turnsAfter),
    { role: "user", content: [{ type: "text", text: "and now something else" }] },
  ];
}

// ── A. Config resolver ───────────────────────────────────────────────────────

test("image age: absent config means enabled with a conservative threshold", () => {
  const cfg = resolveImageAgeConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.turns, 20);
});

test("image age: a valid partial config merges over the defaults", () => {
  assert.deepEqual(resolveImageAgeConfig({ turns: 4 }), { enabled: true, turns: 4 });
  assert.deepEqual(resolveImageAgeConfig({ enabled: false }), { enabled: false, turns: 20 });
});

test("image age: invalid fields fall back per field and never throw", () => {
  const cfg = resolveImageAgeConfig({ enabled: "yes", turns: 0 });
  assert.equal(cfg.enabled, true, "non-boolean gate falls back to the default");
  assert.equal(cfg.turns, 20, "a non-positive threshold falls back");
  assert.deepEqual(resolveImageAgeConfig({ turns: 2.5 }), { enabled: true, turns: 20 });
});

test("image age: non-object shapes read as defaults", () => {
  for (const bad of ["on", [true], null]) {
    assert.deepEqual(resolveImageAgeConfig(bad), { enabled: true, turns: 20 }, `bad=${JSON.stringify(bad)}`);
  }
});

test("image age: the getter reads settings on every call", () => {
  writeSettings({ context: { imageAge: { enabled: false, turns: 7 } } });
  assert.deepEqual(getImageAgeConfig(), { enabled: false, turns: 7 });
  writeSettings({ context: { imageAge: { turns: 3 } } });
  assert.deepEqual(getImageAgeConfig(), { enabled: true, turns: 3 });
  writeSettings(null);
  assert.deepEqual(getImageAgeConfig(), { enabled: true, turns: 20 });
});

// ── B. The replacement ───────────────────────────────────────────────────────

test("an image past the threshold becomes a pointer that names the file and the tool", async () => {
  writeSettings(null);
  resetImagePolicyHealth();
  const handler = contextHandler();
  const messages = transcript({ turnsAfter: 20 });
  const before = getImagePolicyHealth().imagesAged;

  const out = await handler({ type: "context", messages }, {});

  assert.ok(out && Array.isArray(out.messages), "the per-request view is returned");
  const aged = out.messages[2];
  assert.deepEqual(
    aged.content.map((b) => b.type),
    ["text", "text"],
    "the image block is replaced in place, the leading text stays",
  );
  const pointer = aged.content[1].text;
  assert.ok(pointer.includes(SOURCE_FILE), `pointer names the file: ${pointer}`);
  assert.ok(pointer.includes(`read("${SOURCE_FILE}")`), "pointer names the tool that re-reads it");
  assert.ok(pointer.includes("image/png"), "pointer keeps the mime type");
  assert.ok(pointer.includes(String(IMAGE_DATA.length)), "pointer keeps the image size");
  assert.ok(!JSON.stringify(out.messages).includes(IMAGE_DATA), "no image data survives in the view");
  assert.deepEqual(
    aged.content[0],
    { type: "text", text: "decoded render.png" },
    "other blocks are untouched",
  );
  assert.equal(aged.toolCallId, "call_image", "the result's pairing fields are kept");
  assert.equal(messages[2].content[1].type, "image", "the session's own array is not mutated");
  assert.equal(getImagePolicyHealth().imagesAged, before + 1, "the counter moves once");
});

test("the pointer is stable across requests and the counter does not double count", async () => {
  writeSettings(null);
  resetImagePolicyHealth();
  const handler = contextHandler();
  const messages = transcript();
  const first = await handler({ type: "context", messages }, {});
  const agedOnce = getImagePolicyHealth().imagesAged;
  const second = await handler({ type: "context", messages }, {});
  assert.equal(second.messages[2].content[1].text, first.messages[2].content[1].text);
  assert.equal(getImagePolicyHealth().imagesAged, agedOnce, "one aged image set counts once");
});

test("the threshold is the owner's: an image younger than it stays an image", async () => {
  writeSettings(null);
  const handler = contextHandler();
  const out = await handler({ type: "context", messages: transcript({ turnsAfter: 19 }) }, {});
  assert.equal(out, undefined, "nothing to change");
});

test("the threshold is configurable: turns=2 ages an image that turns=20 would keep", async () => {
  writeSettings({ context: { imageAge: { turns: 2 } } });
  const handler = contextHandler();
  const out = await handler({ type: "context", messages: transcript({ turnsAfter: 3 }) }, {});
  assert.ok(out && Array.isArray(out.messages), "the lower threshold fires");
  assert.ok(
    out.messages[2].content.some((b) => b.type === "text" && b.text.includes("read(")),
    "the pointer is in place",
  );
  writeSettings(null);
});

// ── C. The safety leg ────────────────────────────────────────────────────────

test("a missing file is never replaced by a pointer", async () => {
  writeSettings(null);
  const handler = contextHandler();
  const out = await handler(
    { type: "context", messages: transcript({ callPath: join(FAKE_HOME, "not-there.png") }) },
    {},
  );
  assert.equal(out, undefined, "no replacement when the bytes behind it are gone");
});

test("an empty file is never replaced by a pointer", async () => {
  writeSettings(null);
  const handler = contextHandler();
  const empty = join(FAKE_HOME, "empty.png");
  writeFileSync(empty, "");
  const out = await handler({ type: "context", messages: transcript({ callPath: empty }) }, {});
  assert.equal(out, undefined, "a zero-byte file is not a recoverable image");
});

test("a relative path is never replaced by a pointer", async () => {
  writeSettings(null);
  const handler = contextHandler();
  const out = await handler({ type: "context", messages: transcript({ callPath: "render.png" }) }, {});
  assert.equal(out, undefined, "the cwd it resolved against is not recoverable here");
});

test("an image whose tool call names no file is never replaced", async () => {
  writeSettings(null);
  const handler = contextHandler();
  const messages = transcript();
  // The call names no path at all (a screenshot tool, say).
  messages[1] = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_image", name: "screenshot", arguments: {} }],
  };
  const out = await handler({ type: "context", messages }, {});
  assert.equal(out, undefined, "no recoverable path, no pointer");
});

test("the off switch stops the pass", async () => {
  writeSettings({ context: { imageAge: { enabled: false } } });
  const handler = contextHandler();
  const out = await handler({ type: "context", messages: transcript() }, {});
  assert.equal(out, undefined, "disabled means images untouched");
  writeSettings(null);
});

test("a result with no image is untouched by the image pass", async () => {
  writeSettings(null);
  const handler = contextHandler();
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    callFor("call_text", SOURCE_FILE),
    { role: "toolResult", toolCallId: "call_text", toolName: "read", content: [{ type: "text", text: "words" }] },
    ...filler(30),
  ];
  const out = await handler({ type: "context", messages }, {});
  assert.equal(out, undefined, "the image pass skips text-only results");
});

// ── D. Composition with the stale text pass ─────────────────────────────────

test("both per-request passes land in one returned array", async () => {
  writeSettings({
    context: {
      imageAge: { turns: 2 },
      staleToolResultOffload: {
        enabled: true,
        minChars: 100,
        stalenessTurns: 1,
        keepRecentTurns: 0,
        maxOffloadCharsPerRun: 1_000_000,
      },
    },
  });
  const handler = contextHandler();
  const messages = [
    { role: "user", content: [{ type: "text", text: "look" }] },
    callFor("call_image", SOURCE_FILE),
    { ...IMAGE_RESULT },
    ...filler(3),
    {
      role: "toolResult",
      toolCallId: "call_big_text",
      toolName: "bash",
      content: [{ type: "text", text: "T".repeat(5_000) }],
    },
    ...filler(2, "g"),
  ];
  const out = await handler(
    { type: "context", messages },
    { sessionManager: { getSessionId: () => "image-age-composition" } },
  );
  assert.ok(out && Array.isArray(out.messages), "one view for both passes");
  const aged = out.messages[2];
  assert.ok(
    aged.content.some((b) => b.type === "text" && b.text.startsWith("[image omitted after")),
    "the image became a pointer",
  );
  const stubbed = out.messages.find(
    (m) => m.role === "toolResult" && typeof m.content?.[0]?.text === "string" && m.content[0].text.startsWith("[offloaded:"),
  );
  assert.ok(stubbed, "the stale text result became a flush stub in the same array");
  assert.equal(messages[2].content[1].type, "image", "the input array is never mutated");
  writeSettings(null);
});

// ── The report line ─────────────────────────────────────────────────────────

test("the report line names every counter that moved, and nothing when none did", async () => {
  resetImagePolicyHealth();
  assert.equal(formatImagePolicyLine(), undefined, "silent when no image work happened");
  const handler = contextHandler();
  await handler({ type: "context", messages: transcript() }, {});
  const line = formatImagePolicyLine();
  assert.ok(line && line.includes("1 aged"), `line: ${line}`);
  resetImagePolicyHealth();
});

test.after(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
});
