/**
 *: capture-time toolResult size cap (braid.context.toolResultSizeCap).
 *
 * Charter: 413-QUOTA-BURN — when a tool result exceeds the cap
 * (default 256KB, default ON) at CAPTURE time, the full content is flushed
 * LOSSLESSLY to disk (JSON — text and images) and the stored session entry
 * carries a stub pointing at the flush file. Screenshots/base64 blobs never
 * enter context in the first place — the root-cause complement to the
 * emergency offloader.
 *
 * Behaviors pinned here:
 * A. Config resolver: absent → defaults with enabled=TRUE; valid merge;
 * invalid per-field → default; non-object → defaults.
 * B. Handler (registered on `tool_result`): oversized text blob → stub +
 * disk file; oversized image (base64) blob → stub with a non-text
 * marker + disk file; under-cap → untouched (undefined); disabled →
 * untouched; already-stubbed → untouched (idempotence); flush failure →
 * original kept (lossless wins over cap).
 * C. pi-core integration: the INSTALLED pi-coding-agent ExtensionRunner
 * merges a tool_result handler's returned { content } into the event
 * (the capture-time substitution pi-core stores into the session).
 *
 * Settings + storage isolation: HOME redirected to a temp dir BEFORE the
 * dist imports (same pattern as test-stale-toolresult-offload.mjs).
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate settings AND offload storage: temp home. MUST precede imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w115-capture-"));
process.env.HOME = FAKE_HOME;
const SETTINGS_PATH = join(FAKE_HOME, ".pi", "agent", "settings.json");
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

const { resolveToolResultSizeCapConfig, getToolResultSizeCapConfig } =
  await import("../../../dist/lib/config/braid-settings.js");
const { registerToolResultCaptureCap } =
  await import("../../../dist/extensions/memory/context-manager/handlers/toolresult-capture-cap.js");
const { estimateMessageChars } =
  await import("../../../dist/extensions/memory/context-manager/handlers/context-emergency.js");

// Installed pi-core — proves the capture merge end-to-end (test C).
const { ExtensionRunner } =
  await import("../../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");

console.log("=== capture-time toolResult size cap ===\n");

let passed = 0;
let failed = 0;
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain
    .then(
      () => fn(),
      () => {},
    )
    .then(
      () => {
        console.log(` [v] ${name}`);
        passed++;
      },
      (e) => {
        console.log(` [x] ${name}: ${e.message}`);
        failed++;
      },
    );
}

function writeSettings(braid) {
  if (braid === null) {
    rmSync(SETTINGS_PATH, { force: true });
    return;
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify({ braid }));
}

// ── A. Config resolver ────────────────────────────────────────────────────────

test("resolver: absent → defaults with enabled=TRUE (blobs never enter context)", () => {
  const c = resolveToolResultSizeCapConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.maxChars, 262_144);
});

test("resolver: valid partial config merges over defaults", () => {
  const c = resolveToolResultSizeCapConfig({ enabled: true, maxChars: 1000 });
  assert.equal(c.enabled, true);
  assert.equal(c.maxChars, 1000);
});

test("resolver: invalid fields fall back per-field (no throw)", () => {
  const c = resolveToolResultSizeCapConfig({ enabled: 1, maxChars: -3 });
  assert.equal(c.enabled, true);
  assert.equal(c.maxChars, 262_144);
});

test("resolver: non-object shapes (string, array, null) → all defaults", () => {
  for (const bad of ["on", [true], null]) {
    const c = resolveToolResultSizeCapConfig(bad);
    assert.equal(c.enabled, true, `bad=${JSON.stringify(bad)}`);
    assert.equal(c.maxChars, 262_144);
  }
});

test("getter mirrors the resolver against live settings (fresh reads)", () => {
  writeSettings({ context: { toolResultSizeCap: { enabled: false } } });
  assert.equal(getToolResultSizeCapConfig().enabled, false);
  writeSettings(null);
  assert.equal(getToolResultSizeCapConfig().enabled, true);
});

test("estimateMessageChars: text, image data, and mixed content", () => {
  assert.equal(estimateMessageChars([{ type: "text", text: "abcd" }]), 4);
  assert.equal(
    estimateMessageChars([
      { type: "text", text: "ab" },
      { type: "image", data: "XYZ" },
    ]),
    5,
  );
  assert.equal(estimateMessageChars("string-content"), 14);
  assert.equal(estimateMessageChars(null), 0);
});

// ── B. Handler behavior ───────────────────────────────────────────────────────

function captureHandler() {
  const captured = [];
  const fakePi = { on: (type, fn) => captured.push({ type, fn }) };
  registerToolResultCaptureCap(fakePi);
  return captured.find((h) => h.type === "tool_result").fn;
}

const FAKE_CTX = { sessionManager: { getSessionId: () => "w115cap" } };

test("capture cap: oversized text blob in → stub + disk file out", async () => {
  writeSettings(null); // default ON
  const handler = captureHandler();
  const blob = "B".repeat(300_000);
  const event = {
    type: "tool_result",
    toolCallId: "cap_call_1",
    toolName: "bash",
    input: {},
    content: [{ type: "text", text: blob }],
    isError: false,
  };
  const result = await handler(event, FAKE_CTX);
  assert.ok(result && result.content, "handler returns replacement content");
  const stub = result.content[0].text;
  assert.ok(stub.startsWith("[offloaded: bash result,"), `stub: ${stub.slice(0, 60)}`);
  assert.ok(stub.includes("flushed to disk:"), "stub names the flush seam");
  const m = stub.match(/flushed to disk: (\S+)\]/);
  assert.ok(m, "stub carries the flush path");
  assert.ok(existsSync(m[1]), "flush file exists");
  const parsed = JSON.parse(readFileSync(m[1], "utf-8"));
  assert.equal(parsed[0].text, blob, "flush is LOSSLESS (full original on disk)");
  assert.ok(stub.includes("[first 500 chars: BBBB"), "stub keeps a 500-char inline head");
});

test("capture cap: oversized IMAGE (base64) blob → stub with non-text marker + recovery affordance", async () => {
  writeSettings(null);
  const handler = captureHandler();
  const event = {
    type: "tool_result",
    toolCallId: "cap_call_2",
    toolName: "screenshot",
    input: {},
    content: [
      { type: "text", text: "screenshot taken" },
      { type: "image", data: "P".repeat(300_000), mimeType: "image/png" },
    ],
    isError: false,
  };
  const result = await handler(event, FAKE_CTX);
  assert.ok(result && result.content, "image blob is capped");
  const stub = result.content[0].text;
  assert.ok(stub.startsWith("[offloaded: screenshot result,"), "stub present");
  assert.ok(stub.includes("[non-text content: image image/png"), "explicit non-text marker");
  // The FULL content (image data included) is on disk.
  const m = stub.match(/flushed to disk: (\S+)\]/);
  const parsed = JSON.parse(readFileSync(m[1], "utf-8"));
  assert.equal(parsed[1].data, "P".repeat(300_000), "image data flushed losslessly");
  assert.ok(!JSON.stringify(result.content).includes("P".repeat(1000)), "no base64 in context");
  // New intended behavior: the stub names the recovery affordance with the
  // exact invocation, so reading the image back does not re-cap it (the
  // read-the-PNG loop from the offload-context report).
  assert.ok(stub.includes("offload_recover("), "stub names the recovery tool");
  assert.ok(
    stub.includes(`offload_recover("${m[1]}")`),
    "recovery line carries the exact flush path",
  );
  assert.ok(!stub.includes("source: "), "no fabricated source when the input names no file");
});

test("capture cap: stub carries the producing path when the tool input names one", async () => {
  writeSettings(null);
  const handler = captureHandler();
  const event = {
    type: "tool_result",
    toolCallId: "cap_call_2b",
    toolName: "read",
    input: { path: "/tmp/render.png", offset: 1 },
    content: [{ type: "image", data: "P".repeat(300_000), mimeType: "image/png" }],
    isError: false,
  };
  const result = await handler(event, FAKE_CTX);
  assert.ok(result && result.content, "oversized result is capped");
  const stub = result.content[0].text;
  assert.ok(stub.includes("source: /tmp/render.png"), "stub names the producing path");
});

test("capture cap: under-cap result → untouched (undefined return)", async () => {
  writeSettings(null);
  const handler = captureHandler();
  const event = {
    type: "tool_result",
    toolCallId: "cap_call_3",
    toolName: "bash",
    input: {},
    content: [{ type: "text", text: "normal sized output" }],
    isError: false,
  };
  assert.equal(await handler(event, FAKE_CTX), undefined);
});

test("capture cap: disabled (enabled=false) → oversized result untouched", async () => {
  writeSettings({ context: { toolResultSizeCap: { enabled: false } } });
  const handler = captureHandler();
  const event = {
    type: "tool_result",
    toolCallId: "cap_call_4",
    toolName: "bash",
    input: {},
    content: [{ type: "text", text: "Z".repeat(300_000) }],
    isError: false,
  };
  assert.equal(await handler(event, FAKE_CTX), undefined);
  writeSettings(null);
});

test("capture cap: already-stubbed content → untouched (idempotence)", async () => {
  writeSettings(null);
  const handler = captureHandler();
  const event = {
    type: "tool_result",
    toolCallId: "cap_call_5",
    toolName: "bash",
    input: {},
    content: [
      {
        type: "text",
        text: "[offloaded: bash result, 300000 bytes — flushed to disk: /tmp/x.txt]",
      },
    ],
    isError: false,
  };
  assert.equal(await handler(event, FAKE_CTX), undefined, "stubbed content never re-capped");
});

test("capture cap: exactly at cap → untouched (strictly greater triggers)", async () => {
  writeSettings(null);
  const handler = captureHandler();
  const event = {
    type: "tool_result",
    toolCallId: "cap_call_6",
    toolName: "bash",
    input: {},
    content: [{ type: "text", text: "E".repeat(262_144) }],
    isError: false,
  };
  assert.equal(await handler(event, FAKE_CTX), undefined);
});

// ── C. pi-core integration: the runner merges the returned content ────────────

test("pi-core emitToolResult applies the capture replacement (installed runtime)", async () => {
  writeSettings(null);
  const handler = captureHandler();
  const ext = { path: "w115-cap-test", handlers: new Map([["tool_result", [handler]]]) };
  const runner = new ExtensionRunner([ext], {}, process.cwd());
  const blob = "Q".repeat(300_000);
  const merged = await runner.emitToolResult({
    type: "tool_result",
    toolName: "bash",
    toolCallId: "cap_call_7",
    input: {},
    content: [{ type: "text", text: blob }],
    isError: false,
  });
  assert.ok(merged, "runner reports a modification");
  assert.ok(merged.content[0].text.startsWith("[offloaded: bash result,"), "content replaced");
  assert.ok(
    !merged.content[0].text.includes("Q".repeat(501)),
    "blob (beyond the 500-char head) NOT in the stored content",
  );
  // The flush file holds the full original.
  const m = merged.content[0].text.match(/flushed to disk: (\S+)\]/);
  assert.equal(JSON.parse(readFileSync(m[1], "utf-8"))[0].text, blob);
  writeSettings(null);
});

await chain;
console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== capture cap tests passed ===");
