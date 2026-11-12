/**
 * callVision: the image-carrying auxiliary call.
 *
 * The contract under test, in the order the failures would bite:
 *
 *   1. the images reach the provider - the stub is handed the message the real
 *      call would send, and the image parts are present with the bytes and the
 *      MIME type the caller supplied, after the text instruction;
 *   2. a model that declares no image input is refused before a request is
 *      made, because a text-only model either errors at the provider or answers
 *      from the instruction alone, and the second one is indistinguishable from
 *      a real answer in a report;
 *   3. a malformed image part is refused, not sent;
 *   4. the text path is unchanged: `callLlm` still sends a string, so nothing
 *      that used to work now carries an array;
 *   5. an image is priced by the pre-send budget, so an image-heavy request
 *      against a window the text alone would fit is refused instead of being
 *      sent to fail.
 *
 * SAFETY: no network, no key. The provider call is stubbed through the module's
 * own test seam (`__setCompleteSimpleForTest`), which is the same seam the
 * timeout and abort suites use; a model object is a plain literal.
 *
 * Run: node --test packages/core/test/runtime/lib/test-vision-call.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The settings root is read lazily by the budget's window resolution. Pinning it
// to an empty directory keeps a configured cap on the developer's machine from
// deciding this suite's window; the arms below set the window on the model, and
// a configured cap can only clamp below it.
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "vision-call-"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const {
  callLlm,
  callVision,
  __setCompleteSimpleForTest,
  __resetRateLimitCooldownForTest,
} = await import(join(ROOT, "dist", "lib", "ai", "llm-call.js"));
const { resolveVisionModel, searchVisionModel } = await import(
  join(ROOT, "dist", "lib", "ai", "model-resolver.js")
);
const { setCustomModelKey } = await import(join(ROOT, "dist", "lib", "state", "global-state.js"));

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Base64-shaped payloads: the transport never decodes them, so bytes need not decode. */
const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNk+M/AwMDAwMDAwMAAAA4BAQH/8k5lQwAAAABJRU5ErkJggg==";

const VISION_MODEL = {
  id: "stub/vision-model",
  provider: "stub",
  api: "openai-completions",
  name: "stub vision",
  baseUrl: "http://stub.invalid",
  input: ["text", "image"],
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 4_096,
};

const TEXT_ONLY_MODEL = { ...VISION_MODEL, id: "stub/text-only", input: ["text"] };

const INSTRUCTION =
  "Judge this page. Name the thing the eye lands on first and say whether the " +
  "rest of the page agrees with it.";

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "stub",
    model: "stub/vision-model",
    usage: { input: 1_234, output: 56, totalTokens: 1_290 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** A stub completion that records the context it was handed. */
function recordingStub(text = "the eye lands on the heading") {
  const calls = [];
  const stub = async (model, context, options) => {
    calls.push({ model, context, options });
    return assistantMessage(text);
  };
  stub.calls = calls;
  return stub;
}

async function withStub(stubFn, fn) {
  __resetRateLimitCooldownForTest();
  __setCompleteSimpleForTest(stubFn);
  try {
    return await fn();
  } finally {
    __setCompleteSimpleForTest(null);
  }
}

/** The user content the request carried, as blocks. */
function contentBlocks(call) {
  const content = call.context.messages[0].content;
  return Array.isArray(content) ? content : [{ type: "text", text: content }];
}

// ── 1. the images reach the provider ─────────────────────────────────────────

test("callVision sends the instruction as text, then the images in order", async () => {
  const stub = recordingStub();
  await withStub(stub, async () => {
    const result = await callVision(
      VISION_MODEL,
      "fake-key",
      "You review pages.",
      INSTRUCTION,
      [
        { data: PNG_A, mimeType: "image/png" },
        { data: PNG_B, mimeType: "image/jpeg" },
      ],
      { maxRetries: 0, sdkRetries: 0 },
    );

    assert.equal("error" in result, false, `expected a text result, got ${JSON.stringify(result)}`);
    assert.equal(result.text, "the eye lands on the heading");
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(result.usage, { input: 1_234, output: 56, totalTokens: 1_290 });
  });

  assert.equal(stub.calls.length, 1, "one attempt must reach the provider exactly once");
  const blocks = contentBlocks(stub.calls[0]);
  assert.equal(blocks.length, 3, `expected text + 2 images, got ${JSON.stringify(blocks)}`);
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[0].text, INSTRUCTION, "the instruction must survive unchanged");
  assert.deepEqual(blocks[1], { type: "image", data: PNG_A, mimeType: "image/png" });
  assert.deepEqual(blocks[2], { type: "image", data: PNG_B, mimeType: "image/jpeg" });
  assert.equal(stub.calls[0].context.systemPrompt, "You review pages.");
});

test("callVision surfaces a provider error as { error }, never as a success", async () => {
  // A route that rejects image input answers with a provider error; the call
  // must report it rather than handing back an empty string that a reporter
  // would render as "the model said nothing".
  const stub = async () => ({
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "stub",
    model: "stub/vision-model",
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: "error",
    errorMessage: "400 invalid request: image input is not supported by this model",
    timestamp: Date.now(),
  });
  await withStub(stub, async () => {
    const result = await callVision(
      VISION_MODEL,
      "fake-key",
      "system",
      INSTRUCTION,
      [{ data: PNG_A, mimeType: "image/png" }],
      { maxRetries: 0, sdkRetries: 0 },
    );
    assert.ok("error" in result, `expected { error }, got ${JSON.stringify(result)}`);
    assert.match(result.error, /image input is not supported/);
  });
});

// ── 2. a text-only model is refused before anything is sent ─────────────────

test("callVision refuses a model that declares no image input, without calling it", async () => {
  const stub = recordingStub();
  await withStub(stub, async () => {
    const result = await callVision(
      TEXT_ONLY_MODEL,
      "fake-key",
      "system",
      INSTRUCTION,
      [{ data: PNG_A, mimeType: "image/png" }],
      { maxRetries: 0, sdkRetries: 0 },
    );
    assert.ok("error" in result, `expected { error }, got ${JSON.stringify(result)}`);
    assert.match(result.error, /Image input refused/);
    assert.match(result.error, /stub\/text-only/, "the refusal must name the model");
    assert.match(result.error, /declares input \[text\]/, "and what it does accept");
  });
  assert.equal(stub.calls.length, 0, "a refused request must not reach the provider");
});

test("callLlm refuses images on a text-only model too, so the option is not a bypass", async () => {
  const stub = recordingStub();
  await withStub(stub, async () => {
    const result = await callLlm(TEXT_ONLY_MODEL, "fake-key", "system", INSTRUCTION, {
      images: [{ data: PNG_A, mimeType: "image/png" }],
      maxRetries: 0,
      sdkRetries: 0,
    });
    assert.ok("error" in result, `expected { error }, got ${JSON.stringify(result)}`);
    assert.match(result.error, /does not accept images/);
  });
  assert.equal(stub.calls.length, 0);
});

// ── 3. malformed image parts ────────────────────────────────────────────────

test("callVision refuses an image with no bytes", async () => {
  const stub = recordingStub();
  await withStub(stub, async () => {
    const result = await callVision(VISION_MODEL, "fake-key", "system", INSTRUCTION, [
      { data: "", mimeType: "image/png" },
    ]);
    assert.ok("error" in result);
    assert.match(result.error, /Image part 1 of 1 carries no data/);
  });
  assert.equal(stub.calls.length, 0);
});

test("callVision refuses a part whose MIME type is not an image", async () => {
  const stub = recordingStub();
  await withStub(stub, async () => {
    const result = await callVision(VISION_MODEL, "fake-key", "system", INSTRUCTION, [
      { data: PNG_A, mimeType: "image/png" },
      { data: PNG_B, mimeType: "text/html" },
    ]);
    assert.ok("error" in result);
    assert.match(result.error, /Image part 2 of 2 declares no image MIME type/);
  });
  assert.equal(stub.calls.length, 0);
});

test("callVision refuses a call with no images at all", async () => {
  const stub = recordingStub();
  await withStub(stub, async () => {
    const result = await callVision(VISION_MODEL, "fake-key", "system", INSTRUCTION, []);
    assert.ok("error" in result);
    assert.match(result.error, /needs at least one image part/);
  });
  assert.equal(stub.calls.length, 0);
});

// ── 4. the text path is unchanged ───────────────────────────────────────────

test("callLlm still sends a plain string when no images are attached", async () => {
  const stub = recordingStub("plain answer");
  await withStub(stub, async () => {
    const result = await callLlm(VISION_MODEL, "fake-key", "system", INSTRUCTION, {
      maxRetries: 0,
      sdkRetries: 0,
    });
    assert.equal("error" in result, false);
    assert.equal(result.text, "plain answer");
  });
  assert.equal(stub.calls.length, 1);
  const content = stub.calls[0].context.messages[0].content;
  assert.equal(typeof content, "string", `text calls must keep string content, got ${typeof content}`);
  assert.equal(content, INSTRUCTION);
});

// ── 5. an image is priced by the pre-send budget ────────────────────────────

test("callVision is refused when the image does not fit the window the text fits", async () => {
  // 4_500 tokens holds the instruction (a few tokens) plus the 1_000-token
  // minimum output budget, but not that plus the per-image allowance the
  // request adds (see IMAGE_TOKEN_ALLOWANCE in lib/ai/llm-call.ts). The
  // text-only control below proves the refusal is the image's cost and not the
  // window's size.
  const tight = { ...VISION_MODEL, id: "stub/tight-window", contextWindow: 4_500 };
  const stub = recordingStub();
  await withStub(stub, async () => {
    const withImage = await callVision(tight, "fake-key", "system", "Look at this.", [
      { data: PNG_A, mimeType: "image/png" },
    ]);
    assert.ok("error" in withImage, `expected the budget to refuse, got ${JSON.stringify(withImage)}`);
    assert.match(withImage.error, /Context budget refused/);

    const textOnly = await callLlm(tight, "fake-key", "system", "Look at this.", {
      maxRetries: 0,
      sdkRetries: 0,
    });
    assert.equal("error" in textOnly, false, `text-only must fit: ${JSON.stringify(textOnly)}`);
  });
});

// ── 6. the resolution the vision call is handed ─────────────────────────────
//
// The tool does not choose a model; it is handed the one `resolveVisionModel`
// names. These arms pin the three rungs of that walk and the trace a refusal is
// built from, so a report that says "no image-capable model" can always say
// which rungs it passed over.

function registry({ find = () => undefined, available = [] } = {}) {
  return {
    find: (provider, id) => find(provider, id),
    getAll: () => available,
    getAvailable: () => available,
    getApiKeyForProvider: async () => null,
  };
}

test("resolution: an image-capable session model is used as-is", () => {
  setCustomModelKey("utilityModel", ["stub/other"]);
  try {
    const search = searchVisionModel({ model: VISION_MODEL, modelRegistry: registry() });
    assert.equal(search.source, "current");
    assert.equal(search.model?.id, "stub/vision-model");
    assert.equal(resolveVisionModel({ model: VISION_MODEL, modelRegistry: registry() }), search.model);
  } finally {
    setCustomModelKey("utilityModel", undefined);
  }
});

test("resolution: a text-only session model falls to the utility model's first image-capable entry", () => {
  // Catalog ids carry no provider prefix; a role pattern is "provider/id" and
  // resolves through find(provider, id).
  const textOnly = { ...TEXT_ONLY_MODEL, id: "text-only" };
  const vision = { ...VISION_MODEL, id: "vision-model" };
  setCustomModelKey("utilityModel", ["stub/text-only", "stub/vision-model"]);
  try {
    const available = [textOnly, vision];
    const search = searchVisionModel({
      model: textOnly,
      modelRegistry: registry({
        find: (provider, id) => available.find((m) => m.provider === provider && m.id === id),
        available,
      }),
    });
    assert.equal(search.source, "utilityModel");
    assert.equal(search.model?.id, "vision-model");
    assert.ok(
      search.tried.some((line) => line.includes('"stub/text-only"') && line.includes("no image input")),
      `the skipped text-only entry must be traced: ${JSON.stringify(search.tried)}`,
    );
  } finally {
    setCustomModelKey("utilityModel", undefined);
  }
});

test("resolution: with nothing image-capable, every rung is named", () => {
  const textOnly = { ...TEXT_ONLY_MODEL, id: "text-only" };
  setCustomModelKey("utilityModel", ["missing/none"]);
  try {
    const search = searchVisionModel({
      model: textOnly,
      modelRegistry: registry({ available: [textOnly] }),
    });
    assert.equal(search.model, undefined);
    assert.equal(search.source, null);
    assert.equal(search.tried.length, 3, `one line per rung: ${JSON.stringify(search.tried)}`);
    assert.match(search.tried[0], /current model stub\/text-only: declares input \[text\]/);
    assert.match(search.tried[1], /utilityModel "missing\/none": no provider serves this pattern/);
    assert.match(search.tried[2], /available models: 1, 0 accept image input/);
  } finally {
    setCustomModelKey("utilityModel", undefined);
  }
});
