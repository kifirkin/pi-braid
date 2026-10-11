/**
 * Offload recovery for capture-capped image results (offload_recover).
 *
 * The capture cap stubs oversized tool results and flushes them losslessly to
 * disk. For images the stub carried no pixels and the only recovery - reading
 * the image back - produced another oversized result, which the same cap
 * stubbed again: a closed loop where a large render never reaches the model.
 *
 * Behaviors pinned here:
 * A. Loop pin: oversized image result -> capture stub -> offload_recover on
 *    the flush path returns a viewable image under the budget, and feeding
 *    that result back through the capture cap leaves it untouched.
 * B. Original preserved: the flush file still holds the full original.
 * C. Fits-already: a small image flush file returns the original bytes
 *    unchanged (no round-trip through the resizer).
 * D. Path safety: refusal outside the offload directory, traversal included.
 * E. No-image flush file: honest text pointing at read (no image blocks).
 * F. Undecodable oversized bytes: honest text, no image, no re-offload.
 * G. Budget: a maxChars override is clamped to the cap; a tiny budget is an
 *    honest refusal rather than a re-offload.
 * H. Registration + internal classification.
 *
 * HOME redirected before the dist imports (capture-cap test pattern).
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// Isolate settings AND offload storage: temp home. MUST precede imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "offrecov-"));
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

const { registerToolResultCaptureCap } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/toolresult-capture-cap.js"
);
const { estimateMessageChars } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/context-emergency.js"
);
const { OFFLOAD_DIR } = await import("../../../dist/lib/config/braid-paths.js");
const { INTERNAL_TOOLS } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/shared.js"
);
const { registerOffloadRecover } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/tools/offload-recover.js"
);

console.log("=== offload_recover: capture-cap image read-back ===\n");

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

const FAKE_CTX = { sessionManager: { getSessionId: () => "offrecov" } };

function ensureFlushDir(name) {
  const dir = join(OFFLOAD_DIR, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function captureHandler() {
  const captured = [];
  const fakePi = { on: (type, fn) => captured.push({ type, fn }) };
  registerToolResultCaptureCap(fakePi);
  return captured.find((h) => h.type === "tool_result").fn;
}

function recoverTool() {
  const tools = [];
  const fakePi = { registerTool: (t) => tools.push(t) };
  registerOffloadRecover(fakePi);
  const tool = tools.find((t) => t.name === "offload_recover");
  assert.ok(tool, "offload_recover registered");
  return tool;
}

/**
 * Deterministic RGB PNG whose bytes are essentially incompressible
 * (per-pixel splitmix hash), so file size tracks pixel count and the
 * base64 form crosses the capture cap by construction.
 */
function makeNoisePng(width, height) {
  let crcTable = null;
  function crc32(buf) {
    if (!crcTable) {
      crcTable = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c;
      }
    }
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

function imageBlockFrom(png, mime = "image/png") {
  return { type: "image", data: png.toString("base64"), mimeType: mime };
}

// ── A + B. The loop pin ──────────────────────────────────────────────────────

test("loop pin: oversized image -> stub -> offload_recover -> viewable, under budget, never re-capped", async () => {
  writeSettings(null);
  const handler = captureHandler();
  const tool = recoverTool();
  const { png } = makeOverCapPng();
  const data = png.toString("base64");
  assert.ok(data.length > 262_144, `fixture crosses the cap (${data.length} chars)`);

  const event = {
    type: "tool_result",
    toolCallId: "rec_call_1",
    toolName: "read",
    input: { path: "/tmp/render.png" },
    content: [{ type: "text", text: "decoded render.png" }, imageBlockFrom(png)],
    isError: false,
  };
  const result = await handler(event, FAKE_CTX);
  assert.ok(result && result.content, "oversized image is capped");
  const stub = result.content[0].text;
  const m = stub.match(/flushed to disk: (\S+)\]/);
  assert.ok(m, "stub carries the flush path");
  assert.ok(stub.includes(`offload_recover("${m[1]}")`), "stub names the exact recovery");

  // The defect loop: reading the image back re-capped it. The recovery tool
  // must return pixels that the cap lets through.
  const recovered = await tool.execute("rec_call_1x", { path: m[1] }, null, null, FAKE_CTX);
  assert.ok(recovered && Array.isArray(recovered.content), "recovery returns content");
  const note = recovered.content[0];
  assert.equal(note.type, "text", "recovery leads with a note");
  const view = recovered.content.find((b) => b.type === "image");
  assert.ok(view, "recovery returns an image block");
  assert.ok(
    view.mimeType === "image/png" || view.mimeType === "image/jpeg",
    `viewable mime, got ${view.mimeType}`,
  );
  assert.ok(view.data.length <= 262_144 / 2, `view fits the budget (${view.data.length} chars)`);
  assert.ok(note.text.includes("downscaled"), "note says the view is downscaled");

  // The loop is closed: the recovery output passes the capture cap untouched.
  const reCapped = await handler(
    {
      type: "tool_result",
      toolCallId: "rec_call_2",
      toolName: "offload_recover",
      input: { path: m[1] },
      content: recovered.content,
      isError: false,
    },
    FAKE_CTX,
  );
  assert.equal(reCapped, undefined, "recovery result is never re-capped");

  // And the original is still on disk, lossless.
  const flushed = JSON.parse(readFileSync(m[1], "utf-8"));
  assert.equal(flushed[1].data, data, "flush file still holds the full original");
});

test("fits-already: small image returns the original bytes unchanged", async () => {
  const tool = recoverTool();
  const small = makeNoisePng(8, 8);
  const data = small.toString("base64");
  const flushPath = join(ensureFlushDir("offrecov"), "fits-already.txt");
  writeFileSync(flushPath, JSON.stringify([{ type: "text", text: "tiny" }, imageBlockFrom(small)]));
  const out = await tool.execute("rec_call_3", { path: flushPath }, null, null, FAKE_CTX);
  const view = out.content.find((b) => b.type === "image");
  assert.ok(view, "image delivered");
  assert.equal(view.data, data, "original bytes, no round-trip through the resizer");
  assert.ok(out.content[0].text.includes("as-is"), "note says delivered unchanged");
});

// ── D. Path safety ───────────────────────────────────────────────────────────

test("path safety: refusal outside the offload directory, traversal included", async () => {
  const tool = recoverTool();
  for (const p of ["/tmp/not-offload/leak.txt", join(OFFLOAD_DIR, "..", "..", "secret.txt")]) {
    const out = await tool.execute("rec_call_4", { path: p }, null, null, FAKE_CTX);
    assert.ok(!out.content.some((b) => b.type === "image"), `no image for ${p}`);
    assert.ok(out.content[0].text.includes("offload directory"), `refusal explains why: ${p}`);
  }
});

// ── E. No-image flush file ───────────────────────────────────────────────────

test("no-image flush file: honest text pointing at read", async () => {
  const tool = recoverTool();
  const flushPath = join(ensureFlushDir("offrecov"), "text-only.txt");
  writeFileSync(flushPath, JSON.stringify([{ type: "text", text: "just words" }]));
  const out = await tool.execute("rec_call_5", { path: flushPath }, null, null, FAKE_CTX);
  assert.ok(!out.content.some((b) => b.type === "image"), "no image fabricated");
  assert.ok(out.content[0].text.includes("read"), "text points at read for text content");
});

test("flush file unparseable: honest refusal, no image, no throw", async () => {
  const tool = recoverTool();
  const flushPath = join(ensureFlushDir("offrecov"), "garbage.txt");
  writeFileSync(flushPath, "definitely not json");
  const out = await tool.execute("rec_call_6", { path: flushPath }, null, null, FAKE_CTX);
  assert.ok(!out.content.some((b) => b.type === "image"), "no image fabricated");
  assert.ok(out.content[0].text.includes(flushPath), "refusal names the file");
});

// ── F. Undecodable oversized bytes ──────────────────────────────────────────

test("undecodable oversized bytes: honest text, no image, no re-offload", async () => {
  const tool = recoverTool();
  const junk = Buffer.from("not a png at all, just junk bytes".repeat(12_000));
  const data = junk.toString("base64");
  assert.ok(data.length > 262_144 / 2, "junk is over budget so resize is attempted");
  const flushPath = join(ensureFlushDir("offrecov"), "junk-image.txt");
  writeFileSync(flushPath, JSON.stringify([imageBlockFrom(junk)]));
  const out = await tool.execute("rec_call_7", { path: flushPath }, null, null, FAKE_CTX);
  assert.ok(!out.content.some((b) => b.type === "image"), "no image fabricated from junk");
  assert.ok(out.content[0].text.includes("not recoverable"), "note says why");
  assert.ok(out.content[0].text.includes(flushPath), "note names the original");
  assert.ok(estimateMessageChars(out.content) < 262_144, "refusal itself stays under the cap");
});

// ── G. Budget clamp + tiny budget ───────────────────────────────────────────

test("budget: maxChars override is honored and clamped to the cap", async () => {
  const tool = recoverTool();
  const { png } = makeOverCapPng();
  const flushPath = join(ensureFlushDir("offrecov"), "budget.txt");
  writeFileSync(flushPath, JSON.stringify([imageBlockFrom(png)]));
  // A small override forces a tiny view: the budget is respected literally.
  const out = await tool.execute("rec_call_8", { path: flushPath, maxChars: 3000 }, null, null, FAKE_CTX);
  const view = out.content.find((b) => b.type === "image");
  assert.ok(view, "tiny budget still yields a view");
  assert.ok(view.data.length <= 3000 - 1024, `view fits the override (${view.data.length} chars)`);
  // An override above the cap is clamped: the result can never re-cap itself.
  const big = await tool.execute("rec_call_9", { path: flushPath, maxChars: 999_999 }, null, null, FAKE_CTX);
  const bigView = big.content.find((b) => b.type === "image");
  assert.ok(bigView, "clamped budget still yields a view");
  assert.ok(bigView.data.length <= 262_144, `clamped view fits the cap (${bigView.data.length} chars)`);
});

test("tiny budget: honest refusal instead of a re-offload", async () => {
  const tool = recoverTool();
  const { png } = makeOverCapPng();
  const flushPath = join(ensureFlushDir("offrecov"), "tiny.txt");
  writeFileSync(flushPath, JSON.stringify([imageBlockFrom(png)]));
  const out = await tool.execute("rec_call_10", { path: flushPath, maxChars: 1 }, null, null, FAKE_CTX);
  assert.ok(!out.content.some((b) => b.type === "image"), "no image under an impossible budget");
  assert.ok(!existsSync(`${flushPath}.txt`), "refusal never writes a second flush file");
  assert.ok(estimateMessageChars(out.content) < 262_144, "refusal stays under the cap");
});

test("jpeg flush file: screenshot-class payloads recover too", async () => {
  const tool = recoverTool();
  const { resizeImage } = await import(
    "../../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js"
  );
  const { png } = makeOverCapPng();
  // Incompressible noise: the PNG candidate can never win the size race, so
  // the resized encoding is deterministically JPEG (the screenshot class).
  const encoded = await resizeImage(new Uint8Array(png), "image/png", {
    maxBytes: 50_000,
  });
  assert.ok(encoded, "resize produced an encoding");
  assert.equal(encoded.mimeType, "image/jpeg", "fixture is the screenshot class");
  const flushPath = join(ensureFlushDir("offrecov"), "jpeg.txt");
  writeFileSync(
    flushPath,
    JSON.stringify([
      { type: "image", data: encoded.data, mimeType: encoded.mimeType },
    ]),
  );
  // A small budget forces the JPEG through the resizer (it cannot fit as-is).
  const out = await tool.execute(
    "rec_call_11",
    { path: flushPath, maxChars: 3000 },
    null,
    null,
    FAKE_CTX,
  );
  const view = out.content.find((b) => b.type === "image");
  assert.ok(view, "jpeg recovered");
  assert.ok(view.data.length <= 3000 - 1024, `view fits the budget (${view.data.length} chars)`);
  assert.ok(out.content[0].text.includes("downscaled"), "note says downscaled");
});

// ── H. Registration + internal classification ────────────────────────────────

test("registration: schema requires the flush path; classified internal", () => {
  const tools = [];
  const fakePi = { registerTool: (t) => tools.push(t) };
  registerOffloadRecover(fakePi);
  const tool = tools.find((t) => t.name === "offload_recover");
  assert.ok(tool, "tool registered");
  assert.ok(tool.description.includes("offloaded"), "description points at the stub family");
  assert.ok(INTERNAL_TOOLS.has("offload_recover"), "classified internal (offloaders skip it)");
  const json = JSON.stringify(tool.parameters);
  assert.ok(json.includes('"path"'), "schema names the path param");
});

await chain;
console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== offload_recover tests passed ===");
