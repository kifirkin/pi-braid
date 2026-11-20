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
 * disk file; oversized image with decodable bytes → downscaled image kept as
 * an image, under the cap, with the full original on disk; image bytes the
 * resizer refuses (or a result whose text never leaves room for a picture) →
 * stub with a non-text marker, a structured `details` record and the recovery
 * tool activated; under-cap → untouched (undefined); disabled → untouched;
 * already-stubbed → untouched (idempotence); flush failure → original kept
 * (lossless wins over cap).
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
import { deflateSync } from "node:zlib";

// Isolate settings AND offload storage: temp home. MUST precede imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "toolresult-capture-"));
process.env.HOME = FAKE_HOME;
const SETTINGS_PATH = join(FAKE_HOME, ".pi", "agent", "settings.json");
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

const { resolveToolResultSizeCapConfig, getToolResultSizeCapConfig } =
  await import("../../../dist/lib/config/braid-settings.js");
const { registerToolResultCaptureCap } =
  await import("../../../dist/extensions/memory/context-manager/handlers/toolresult-capture-cap.js");
const { estimateMessageChars } =
  await import("../../../dist/extensions/memory/context-manager/handlers/context-emergency.js");
const { getImagePolicyHealth } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/image-policy.js"
);

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

/**
 * Deterministic RGB PNG whose bytes are essentially incompressible (per-pixel
 * splitmix hash), so its file size tracks pixel count and its base64 form
 * crosses the cap by construction. The recovery fixture owns the same
 * generator; a decoder here would add a dependency for one fixture.
 */
function makeNoisePng(width, height) {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      let z = (0x9e3779b9 + x * 0x85ebca6b + y * 0xc2b2ae35) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x2c1b3c6d) >>> 0;
      z = Math.imul(z ^ (z >>> 12), 0x297a2d39) >>> 0;
      z ^= z >>> 15;
      row[1 + x * 3] = (z >>> 16) & 0xff;
      row[1 + x * 3 + 1] = (z >>> 8) & 0xff;
      row[1 + x * 3 + 2] = z & 0xff;
    }
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows), { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Big enough that its base64 form crosses the default 262144-char cap. */
function makeOverCapPng() {
  for (const [w, h] of [[400, 256], [512, 320], [640, 400]]) {
    const png = makeNoisePng(w, h);
    if (Math.ceil(png.length / 3) * 4 > 262_144) return { png, w, h };
  }
  throw new Error("noise PNG never crossed the cap");
}

/**
 * A capture handler plus the tool-set surface the recovery activation reads.
 * `tools.active` is the set the harness would declare on the next request.
 */
function captureHandler() {
  const captured = [];
  const tools = { active: ["read", "bash"], all: [{ name: "offload_recover" }] };
  const fakePi = {
    on: (type, fn) => captured.push({ type, fn }),
    getActiveTools: () => tools.active,
    getAllTools: () => tools.all,
    setActiveTools: (names) => {
      tools.active = names;
    },
  };
  registerToolResultCaptureCap(fakePi);
  return { handler: captured.find((h) => h.type === "tool_result").fn, tools };
}

const FAKE_CTX = { sessionManager: { getSessionId: () => "size-cap-session" } };

test("capture cap: oversized text blob in → stub + disk file out", async () => {
  writeSettings(null); // default ON
  const { handler } = captureHandler();
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

test("capture cap: image bytes the resizer refuses → stub with non-text marker + recovery affordance", async () => {
  writeSettings(null);
  const { handler } = captureHandler();
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
  // The stub names the recovery affordance with the exact invocation, so
  // reading the image back does not re-cap it.
  assert.ok(stub.includes("offload_recover("), "stub names the recovery tool");
  assert.ok(
    stub.includes(`offload_recover("${m[1]}")`),
    "recovery line carries the exact flush path",
  );
  assert.ok(!stub.includes("source: "), "no fabricated source when the input names no file");
});

test("capture cap: oversized DECODABLE image → downscaled image under the cap, original on disk", async () => {
  writeSettings(null);
  const { handler } = captureHandler();
  const { png } = makeOverCapPng();
  const data = png.toString("base64");
  assert.ok(data.length > 262_144, `fixture crosses the cap (${data.length} chars)`);
  const before = getImagePolicyHealth().imagesDownscaled;

  const result = await handler(
    {
      type: "tool_result",
      toolCallId: "cap_call_2c",
      toolName: "read",
      input: { path: "/tmp/render.png" },
      content: [{ type: "text", text: "decoded render.png" }, { type: "image", data, mimeType: "image/png" }],
      isError: false,
      details: { filePath: "/tmp/render.png", lineCount: 1 },
    },
    FAKE_CTX,
  );

  assert.ok(result && Array.isArray(result.content), "oversized image is capped");
  const view = result.content.find((b) => b.type === "image");
  assert.ok(view, "content stays an image (policy: a picture the model can see)");
  assert.ok(
    view.mimeType === "image/png" || view.mimeType === "image/jpeg",
    `viewable mime, got ${view.mimeType}`,
  );
  assert.ok(view.data.length < data.length, `downscaled: ${data.length} -> ${view.data.length} chars`);
  const total = estimateMessageChars(result.content);
  assert.ok(total <= 262_144, `assembled result fits the cap (${total} chars)`);
  assert.deepEqual(
    result.details,
    { filePath: "/tmp/render.png", lineCount: 1 },
    "the tool's own details survive the replacement",
  );

  // Lossless: the flush file holds the full original, and the note names it.
  const texts = result.content.filter((b) => b.type === "text").map((b) => b.text);
  const note = texts.find((t) => t.startsWith("[downscaled to fit the context cap;"));
  assert.ok(note, `note names the full original: ${texts.join(" | ")}`);
  const path = note.match(/full original: (.*)\]$/)[1];
  assert.ok(existsSync(path), "flush file exists");
  const flushed = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(flushed[1].data, data, "flush is LOSSLESS (full original on disk)");
  assert.ok(getImagePolicyHealth().imagesDownscaled > before, "downscale is counted");
});

test("capture cap: a forced image stub records the structured obligation, and the recovery becomes callable", async () => {
  writeSettings(null);
  const { handler, tools } = captureHandler();
  assert.ok(!tools.active.includes("offload_recover"), "recovery starts deferred");
  const { png } = makeOverCapPng();
  const data = png.toString("base64");

  // The text never leaves room for a picture inside the image share of the
  // cap, so the resize cannot fit and the stub is the fallback.
  const result = await handler(
    {
      type: "tool_result",
      toolCallId: "cap_call_2d",
      toolName: "read",
      input: { path: "/tmp/render.png" },
      content: [{ type: "text", text: "T".repeat(250_000) }, { type: "image", data, mimeType: "image/png" }],
      isError: false,
      details: { filePath: "/tmp/render.png" },
    },
    FAKE_CTX,
  );

  assert.ok(result && Array.isArray(result.content), "result is capped");
  assert.equal(result.content.length, 1, "stub replaces the whole content");
  assert.equal(result.content[0].type, "text", "stub is text");
  const stub = result.content[0].text;
  assert.ok(stub.includes("offload_recover("), "stub names the recovery");

  // Read the record, not the prose.
  assert.equal(result.details.kind, "image", "details.kind");
  assert.equal(result.details.mimeType, "image/png", "details.mimeType");
  assert.equal(result.details.dataLength, data.length, "details.dataLength (total image chars)");
  assert.ok(result.details.storedPath, "details.storedPath");
  assert.ok(existsSync(result.details.storedPath), "storedPath exists");
  assert.equal(result.details.filePath, "/tmp/render.png", "the tool's own details are kept");

  assert.ok(tools.active.includes("offload_recover"), "the next request offers the recovery");
  assert.deepEqual(
    tools.active,
    ["read", "bash", "offload_recover"],
    "activation is additive (nothing else dropped)",
  );
});

test("capture cap: a text-only stub does not activate the image recovery", async () => {
  writeSettings(null);
  const { handler, tools } = captureHandler();
  const result = await handler(
    {
      type: "tool_result",
      toolCallId: "cap_call_2e",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "Z".repeat(300_000) }],
      isError: false,
    },
    FAKE_CTX,
  );
  assert.ok(result && result.content, "text result is stubbed");
  assert.equal(result.details, undefined, "no image record for a text stub");
  assert.ok(!tools.active.includes("offload_recover"), "text stubs do not touch the tool set");
});

test("capture cap: stub carries the producing path when the tool input names one", async () => {
  writeSettings(null);
  const { handler } = captureHandler();
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
  const { handler } = captureHandler();
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
  const { handler } = captureHandler();
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
  const { handler } = captureHandler();
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
  const { handler } = captureHandler();
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
  const { handler } = captureHandler();
  const ext = { path: "toolresult-cap-test", handlers: new Map([["tool_result", [handler]]]) };
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

test("pi-core emitToolResult stores a downscaled image result and the tool's details", async () => {
  writeSettings(null);
  const { handler } = captureHandler();
  const ext = { path: "toolresult-cap-test", handlers: new Map([["tool_result", [handler]]]) };
  const runner = new ExtensionRunner([ext], {}, process.cwd());
  const { png } = makeOverCapPng();
  const data = png.toString("base64");
  const details = { filePath: "/tmp/render.png", lineCount: 1 };
  const merged = await runner.emitToolResult({
    type: "tool_result",
    toolName: "read",
    toolCallId: "cap_call_8",
    input: { path: "/tmp/render.png" },
    content: [{ type: "image", data, mimeType: "image/png" }],
    details,
    isError: false,
  });
  assert.ok(merged, "runner reports a modification");
  const view = merged.content.find((b) => b.type === "image");
  assert.ok(view, "the stored content is an image");
  assert.ok(view.data.length < data.length, "the stored image is the downscaled one");
  assert.deepEqual(merged.details, details, "the tool's details reach the stored entry");
  writeSettings(null);
});

test("pi-core emitToolResult stores an image stub's structured details", async () => {
  writeSettings(null);
  const { handler } = captureHandler();
  const ext = { path: "toolresult-cap-test", handlers: new Map([["tool_result", [handler]]]) };
  const runner = new ExtensionRunner([ext], {}, process.cwd());
  const { png } = makeOverCapPng();
  const data = png.toString("base64");
  const merged = await runner.emitToolResult({
    type: "tool_result",
    toolName: "read",
    toolCallId: "cap_call_9",
    input: { path: "/tmp/render.png" },
    content: [{ type: "text", text: "T".repeat(250_000) }, { type: "image", data, mimeType: "image/png" }],
    details: { filePath: "/tmp/render.png" },
    isError: false,
  });
  assert.ok(merged, "runner reports a modification");
  assert.equal(merged.content.length, 1, "the stub replaced the content");
  assert.equal(merged.details.kind, "image", "the record reaches the stored entry");
  assert.equal(merged.details.dataLength, data.length, "the record carries the image size");
  assert.equal(merged.details.filePath, "/tmp/render.png", "the tool's detail is kept");
  assert.ok(existsSync(merged.details.storedPath), "the record's path exists");
  writeSettings(null);
});

await chain;
console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== capture cap tests passed ===");
