/**
 * visual_judge: the tool's own decisions, with the world stubbed.
 *
 * The judge is three seams: capture a PNG, pick a model, ask it. This suite
 * replaces all three, so what it tests is the part that is nobody else's
 * business:
 *
 *   1. every width is judged once, with the bytes of its own PNG, the MIME type
 *      the file really is, and an instruction that carries the rubric and the
 *      width (a judgment of a 320px page and of a 1440px page are different
 *      judgments, so the model has to be told which it is looking at);
 *   2. the report says which model answered, on which route, at what token cost
 *      and how long it took, and says in words that the answer is an opinion;
 *   3. a caller's rubric is sent verbatim;
 *   4. the refusals happen before a request is worth making and print what they
 *      tried: no image-capable model, no key, a page that will not render;
 *   5. a failure at one width (provider rejects the image, a PNG over the limit,
 *      an empty answer) is that width's error and does not take the others down.
 *
 * No browser, no network, no key: the capture stub writes the PNGs itself, the
 * judge stub returns what a model would have said.
 *
 * Run: node --test packages/contrib/test/design/vision.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register(new URL("../lib/ts-resolve.mjs", import.meta.url));

// Private directories, removed when the process exits. The first one is pi's
// agent directory: the extension reads its own enable/disable toggle from
// settings.json, and a developer's local `braid.contrib.design` setting must
// not decide whether this suite sees the tool registered.
const dirs = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "visual-judge-"));
  dirs.push(dir);
  return dir;
}
process.env.PI_CODING_AGENT_DIR = scratch();

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRIB = join(HERE, "..", "..");

const { runVisualJudge, defaultScreenshotDir } = await import(
  pathToFileURL(join(CONTRIB, "design", "vision.ts")).href
);

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Distinct payloads per width, so an arm can prove the right file went with the
// right call. The judge never decodes them.
const PNG_320 = Buffer.from("png-for-320");
const PNG_390 = Buffer.from("png-for-390-different-bytes");
const PNG_1440 = Buffer.from("png-for-1440");

const MODEL = {
  id: "stub/model",
  provider: "stub",
  api: "openai-completions",
  name: "stub model",
  baseUrl: "http://stub.invalid",
  input: ["text", "image"],
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 4_096,
};

const USAGE = { input: 1_100, output: 140, totalTokens: 1_240 };

/**
 * The capture stub. `heights` maps a width to the PNG the adapter would have
 * written; a width missing from it captures no screenshot at all.
 */
function captureStub(
  dir,
  { heights = {}, truncated = [], fail = null, bytes = {} } = {},
) {
  const calls = [];
  const capture = async (target, options) => {
    calls.push({ target, options });
    if (fail !== null) throw new Error(fail);
    return {
      target,
      widths: options.widths.map((width) => {
        const body = bytes[width] ?? heights[width];
        if (body === undefined)
          return { snapshot: { viewportWidth: width }, screenshot: null };
        const path = join(dir, `${width}.png`);
        writeFileSync(path, body);
        return {
          snapshot: { viewportWidth: width },
          screenshot: {
            path,
            height: 2400,
            truncated: truncated.includes(width),
          },
        };
      }),
    };
  };
  capture.calls = calls;
  return capture;
}

/** The judge stub: records each request, answers with `answer` per width. */
function judgeStub({ errors = {}, answers = {}, empty = [] } = {}) {
  const calls = [];
  const judge = async (
    model,
    apiKey,
    systemPrompt,
    instruction,
    images,
    options,
  ) => {
    const width = Number(/rendered at (\d+)px/.exec(instruction)?.[1]);
    calls.push({
      model,
      apiKey,
      systemPrompt,
      instruction,
      images,
      options,
      width,
    });
    if (errors[width] !== undefined) return { error: errors[width] };
    if (empty.includes(width))
      return { text: "", stopReason: "length", usage: USAGE };
    return {
      text: answers[width] ?? `verdict for ${width}`,
      stopReason: "stop",
      usage: USAGE,
    };
  };
  judge.calls = calls;
  return judge;
}

/**
 * A dependency set with every seam replaced. `now` advances 250ms per reading,
 * so one judged width costs 250ms of stubbed clock and the elapsed arithmetic is
 * checkable rather than merely present.
 */
function makeDeps({
  model = MODEL,
  search = {
    model,
    source: "utilityModel",
    tried: [`utilityModel "stub/model": using stub/model`],
  },
  resolveModel = () => model,
  capture,
  judge,
  apiKey = "stub-key",
  clock = { at: 1000 },
} = {}) {
  return {
    resolveModel,
    explainModel: () => search,
    capture,
    judge,
    apiKeyFor: async () => apiKey,
    now: () => {
      clock.at += 250;
      return clock.at;
    },
  };
}

// ── 1. every width is judged once, with its own image ───────────────────────

test("one call per width, each with that width's PNG bytes and MIME type", async () => {
  const dir = scratch();
  const capture = captureStub(dir, { heights: { 320: PNG_320, 390: PNG_390 } });
  const judge = judgeStub();
  const result = await runVisualJudge(
    { target: "https://example.test/page", widths: [320, 390] },
    {},
    makeDeps({ capture, judge }),
  );

  assert.equal(capture.calls.length, 1);
  assert.deepEqual(capture.calls[0].options.widths, [320, 390]);
  assert.equal(judge.calls.length, 2, "one call per width");
  assert.deepEqual(
    judge.calls.map((call) => call.width),
    [320, 390],
    "calls follow the width order",
  );

  assert.equal(judge.calls[0].images.length, 1, "one image per call");
  assert.equal(judge.calls[0].images[0].data, PNG_320.toString("base64"));
  assert.equal(judge.calls[0].images[0].mimeType, "image/png");
  assert.equal(judge.calls[1].images[0].data, PNG_390.toString("base64"));

  assert.match(judge.calls[0].instruction, /rendered at 320px wide/);
  assert.match(judge.calls[1].instruction, /rendered at 390px wide/);
  assert.match(
    judge.calls[0].instruction,
    /Do not give scores/,
    "the default rubric is sent",
  );
  assert.match(judge.calls[0].systemPrompt, /cannot measure pixels/);
  assert.equal(
    judge.calls[0].options.reasoning,
    "off",
    "a judge does not spend the answer on thinking",
  );
  assert.equal(judge.calls[0].apiKey, "stub-key");

  assert.equal(result.widths.length, 2);
  assert.equal(
    result.widths[0].elapsedMs,
    250,
    "elapsed is the stub clock's delta",
  );
  assert.deepEqual(result.widths[0].usage, USAGE);
  assert.equal(result.widths[0].answer, "verdict for 320");
  assert.deepEqual(result.totals, {
    input: 2_200,
    output: 280,
    elapsedMs: 500,
  });
});

test("the report names the model, its route, its cost and that it is an opinion", async () => {
  const dir = scratch();
  const result = await runVisualJudge(
    { target: "https://example.test/page", widths: [390] },
    {},
    makeDeps({
      capture: captureStub(dir, { heights: { 390: PNG_390 } }),
      judge: judgeStub({
        answers: {
          390: "The heading carries the page; the buttons read as links.",
        },
      }),
    }),
  );

  assert.deepEqual(result.model, {
    id: "stub/model",
    provider: "stub",
    api: "openai-completions",
    route: "stub/openai-completions",
  });
  assert.equal(result.modelSource, "utilityModel");

  for (const fragment of [
    "stub/model",
    "route stub/openai-completions",
    "resolved from the utility model",
    "390px",
    "The heading carries the page; the buttons read as links.",
    "1100 in / 140 out tokens",
    "0.3s",
    "not a measurement",
    "design_audit",
  ]) {
    assert.ok(
      result.text.includes(fragment),
      `report must carry ${JSON.stringify(fragment)}`,
    );
  }
});

test("a truncated capture says so in the instruction and in the report", async () => {
  const dir = scratch();
  const judge = judgeStub();
  const result = await runVisualJudge(
    { target: "https://example.test/tall", widths: [1440] },
    {},
    makeDeps({
      capture: captureStub(dir, {
        heights: { 1440: PNG_1440 },
        truncated: [1440],
      }),
      judge,
    }),
  );
  assert.ok(
    result.model !== null,
    `a truncated capture is still judged: ${JSON.stringify(result.model)}`,
  );
  assert.match(
    judge.calls[0].instruction,
    /truncated at the capture limit/,
    "the model must be told it is seeing the top of the page only",
  );
  assert.match(result.text, /Screenshot truncated at 2400px/);
});

// ── 2. a caller's rubric is sent verbatim ────────────────────────────────────

test("a caller's rubric replaces the default and is reported as the caller's", async () => {
  const dir = scratch();
  const judge = judgeStub();
  const rubric =
    "Name three things that look unfinished, and where each one is.";
  const result = await runVisualJudge(
    { target: "https://example.test/page", widths: [390], rubric },
    {},
    makeDeps({
      capture: captureStub(dir, { heights: { 390: PNG_390 } }),
      judge,
    }),
  );

  assert.equal(result.customRubric, true);
  assert.ok(
    judge.calls[0].instruction.startsWith(rubric),
    `the rubric must be sent verbatim, got: ${judge.calls[0].instruction.slice(0, 80)}`,
  );
  assert.ok(!judge.calls[0].instruction.includes("Do not give scores"));
  assert.match(result.text, /Rubric: caller's, sent verbatim/);
});

// ── 3. refusals that stop the run before an image is sent ───────────────────

test("no image-capable model: refuses before rendering, and prints the trace", async () => {
  const dir = scratch();
  const capture = captureStub(dir, { heights: { 320: PNG_320 } });
  const judge = judgeStub();
  const tried = [
    "current model stub/text-only: declares input [text], no image input",
    'utilityModel "stub/missing": no provider serves this pattern',
    "available models: 3, 0 accept image input",
  ];
  await assert.rejects(
    runVisualJudge(
      { target: "https://example.test/page", widths: [320] },
      {},
      makeDeps({
        model: undefined,
        resolveModel: () => undefined,
        search: { model: undefined, source: null, tried },
        capture,
        judge,
      }),
    ),
    (error) => {
      assert.match(error.message, /no image-capable model to judge with/);
      for (const line of tried) {
        assert.ok(
          error.message.includes(line),
          `the refusal must print ${JSON.stringify(line)}`,
        );
      }
      assert.match(error.message, /\/utility-model/);
      return true;
    },
  );
  assert.equal(
    capture.calls.length,
    0,
    "a refused run must not render the page",
  );
  assert.equal(judge.calls.length, 0);
});

test("no API key: refuses with the provider named and sends nothing", async () => {
  const dir = scratch();
  const capture = captureStub(dir, { heights: { 320: PNG_320 } });
  const judge = judgeStub();
  await assert.rejects(
    runVisualJudge(
      { target: "https://example.test/page", widths: [320] },
      {},
      makeDeps({ capture, judge, apiKey: null }),
    ),
    /no API key for provider stub, which serves stub\/stub\/model/,
  );
  assert.equal(capture.calls.length, 0);
  assert.equal(judge.calls.length, 0);
});

test("a page that will not render reports the adapter's error and judges nothing", async () => {
  const judge = judgeStub();
  const dir = scratch();
  await assert.rejects(
    runVisualJudge(
      { target: "https://example.test/gone", widths: [320] },
      {},
      makeDeps({
        capture: captureStub(dir, {
          fail: "navigation failed at 320px: net::ERR_NAME_NOT_RESOLVED",
        }),
        judge,
      }),
    ),
    /net::ERR_NAME_NOT_RESOLVED/,
  );
  assert.equal(judge.calls.length, 0, "a blank page is never judged");
});

// ── 4. a failure at one width is that width's error ─────────────────────────

test("a provider that rejects the image fails one width and leaves the other answered", async () => {
  const dir = scratch();
  const result = await runVisualJudge(
    { target: "https://example.test/page", widths: [320, 390] },
    {},
    makeDeps({
      capture: captureStub(dir, { heights: { 320: PNG_320, 390: PNG_390 } }),
      judge: judgeStub({
        errors: { 320: "400 invalid request: image input is not supported" },
      }),
    }),
  );

  const [failed, answered] = result.widths;
  assert.equal(failed.answer, null);
  assert.match(failed.error, /image input is not supported/);
  assert.equal(failed.usage, null);
  assert.notEqual(failed.elapsedMs, null, "a failed call still has a duration");
  assert.equal(answered.answer, "verdict for 390");
  assert.equal(answered.error, null);
  assert.deepEqual(result.totals, {
    input: 1_100,
    output: 140,
    elapsedMs: 250,
  });
  assert.match(result.text, /Not judged: 400 invalid request/);
  assert.match(result.text, /1 of 2 widths were not judged/);
});

test("a PNG over the request limit is refused by name, and the other width is judged", async () => {
  const dir = scratch();
  const judge = judgeStub();
  const oversized = Buffer.alloc(3_500_001, 0x41);
  const result = await runVisualJudge(
    { target: "https://example.test/tall", widths: [320, 1440] },
    {},
    makeDeps({
      capture: captureStub(dir, { heights: { 320: PNG_320, 1440: oversized } }),
      judge,
    }),
  );

  assert.equal(judge.calls.length, 1, "only the width that fits is sent");
  assert.equal(judge.calls[0].width, 320);
  const refused = result.widths.find((entry) => entry.width === 1440);
  assert.equal(refused.answer, null);
  assert.match(refused.error, /3500001 bytes, over the 3500000-byte limit/);
  assert.match(result.text, /Judge a narrower width or a shorter page/);
});

test("an empty answer is reported as no text, never as a verdict", async () => {
  const dir = scratch();
  const result = await runVisualJudge(
    { target: "https://example.test/page", widths: [390] },
    {},
    makeDeps({
      capture: captureStub(dir, { heights: { 390: PNG_390 } }),
      judge: judgeStub({ empty: [390] }),
    }),
  );
  assert.equal(
    result.widths[0].answer,
    null,
    "an empty string is not a verdict",
  );
  assert.equal(result.widths[0].error, "the model returned no text");
  assert.equal(result.widths[0].stopReason, "length");
  assert.notEqual(result.widths[0].usage, null, "the tokens were still spent");
  assert.match(result.text, /Not judged: the model returned no text/);
  assert.match(result.text, /1 of 1 widths were not judged/);
});

// ── 5. the screenshot directory is shared with design_audit ─────────────────

test("the core build these tests load is not older than the sources it was compiled from", () => {
  // The shared resolve hook points `pi-braid/lib` at packages/core/dist, the
  // artifact an installed extension loads. A stale artifact would let this
  // suite pass against code that is not in the working tree, so the artifact's
  // own timestamp is checked against the newest core source: a source edit
  // without a rebuild reddens here, naming the file and the command.
  const CORE = join(CONTRIB, "..", "core");
  const built = statSync(join(CORE, "dist", "lib", "public.js")).mtimeMs;
  let newest = { path: null, mtimeMs: 0 };
  for (const entry of readdirSync(join(CORE, "src"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(entry.parentPath ?? CORE, entry.name);
    const mtimeMs = statSync(path).mtimeMs;
    if (mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  assert.ok(
    built >= newest.mtimeMs,
    `the core build these tests load is stale: ${newest.path} is newer than ` +
      `packages/core/dist/lib/public.js. Run \`npm run build -w packages/core\` first.`,
  );
});

test("the export the tool needs is present in the built artifact, not only in the source", async () => {
  // The hook resolves to dist. Importing the built entry point directly is what
  // proves the suite exercised the artifact: a build that predates a new export
  // fails here with the export named, instead of the tool failing at runtime
  // with "deps.explainModel is not a function".
  const built = await import(
    pathToFileURL(join(CONTRIB, "..", "core", "dist", "lib", "public.js")).href
  );
  for (const name of [
    "callVision",
    "resolveVisionModel",
    "searchVisionModel",
  ]) {
    assert.equal(
      typeof built[name],
      "function",
      `the built pi-braid/lib must export ${name}`,
    );
  }
});

test("the default screenshot directory is the one design_audit writes", () => {
  const previous = process.env.BRAID_HOME;
  const root = scratch();
  process.env.BRAID_HOME = root;
  try {
    assert.equal(defaultScreenshotDir(), join(root, "design", "screenshots"));
  } finally {
    if (previous === undefined) delete process.env.BRAID_HOME;
    else process.env.BRAID_HOME = previous;
  }
});

test("the index module loads with the judge registered", async () => {
  // The registration is what a session sees. It is checked by loading the
  // extension module and reading the tool names it registered.
  const registered = [];
  const pi = {
    registerTool(definition) {
      registered.push(definition.name);
    },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    registerToolRenderer() {},
    on() {},
  };
  const extension = await import(
    pathToFileURL(join(CONTRIB, "design", "index.ts")).href
  );
  extension.default(pi);
  assert.ok(
    registered.includes("visual_judge"),
    `registered: ${registered.join(", ")}`,
  );
  assert.ok(
    registered.includes("design_audit"),
    `registered: ${registered.join(", ")}`,
  );
});
