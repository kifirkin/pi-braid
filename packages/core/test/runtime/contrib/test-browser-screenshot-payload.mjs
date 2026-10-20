/**
 * browser_screenshot payload fix tests.
 *
 * Root cause (incident): browserScreenshot pushed the raw captured
 * image (PNG at device pixel ratio — multi-MB on dense pages) into the
 * LLM-bound tool-result `content`array whenever the terminal supported
 * images → HTTP 413 request loops. The agent is supposed to read the saved
 * file via the describe_image tool instead.
 *
 * Gates covered:
 * (a) Revert-proof source assertions: browser/index.ts contains NO image
 * content part, NO terminal-image rendering pipeline, and uses the
 * bounded capture path (jpeg-75 defaults, DSF override, clip plan).
 * These fail on the pre-fix code (image push present).
 * (b) Capture-plan math (pure module, imported directly via node's native
 * type stripping): DPR neutralization, long-edge bounding at 1440px,
 * scroll-offset clip origin, garbage-input fallbacks.
 *
 * Run: node test/runtime/contrib/test-browser-screenshot-payload.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRIB_BROWSER = join(HERE, "..", "..", "..", "..", "contrib", "browser");
const INDEX_TS = join(CONTRIB_BROWSER, "index.ts");
const CAPTURE_PLAN_TS = join(CONTRIB_BROWSER, "capture-plan.ts");
const TOOL_INPUTS_TS = join(CONTRIB_BROWSER, "tool-inputs.ts");

assert.ok(existsSync(INDEX_TS), `index.ts not found at ${INDEX_TS}`);
assert.ok(existsSync(CAPTURE_PLAN_TS), `capture-plan.ts not found`);
assert.ok(existsSync(TOOL_INPUTS_TS), `tool-inputs.ts not found`);

const indexSource = readFileSync(INDEX_TS, "utf-8");
const capturePlanSource = readFileSync(CAPTURE_PLAN_TS, "utf-8");
const toolInputsSource = readFileSync(TOOL_INPUTS_TS, "utf-8");

// ── (a) Revert-proof source assertions ──────────────────────────────────

describe("browser_screenshot source contract", () => {
  it("never pushes an image content part into the tool result", () => {
    assert.ok(
      !/type:\s*"image"/.test(indexSource),
      'browser/index.ts must not contain any { type: "image" } content part ' +
        "(LLM payload flooding incident)",
    );
  });

  it("does not import or use the terminal image-rendering pipeline", () => {
    for (const banned of ["getCapabilities", "renderImage", "getPngDimensions"]) {
      assert.ok(
        !indexSource.includes(banned),
        `browser/index.ts must not reference ${banned} (terminal image pipeline removed)`,
      );
    }
  });

  it("defaults capture to jpeg quality 75 (was png/80)", () => {
    assert.ok(
      indexSource.includes('input.format === "png" ? "png" : "jpeg"'),
      "format default must be jpeg (param may override to png)",
    );
    // The default lives in the shared resolver, not in index.ts: a source-text
    // grep for the constant here bound the contract to a file layout and broke
    // when the input handling moved out. Assert the delegation, the resolver's
    // use of the constant, and the shipped number.
    assert.ok(
      indexSource.includes("resolveJpegQuality"),
      "index.ts must take the quality default from the shared resolver",
    );
    assert.ok(
      /positiveNumber\(value\)\s*\?\?\s*DEFAULT_JPEG_QUALITY/.test(toolInputsSource),
      "the resolver must fall back to DEFAULT_JPEG_QUALITY, not a literal",
    );
    assert.ok(
      /export const DEFAULT_JPEG_QUALITY = 75/.test(capturePlanSource),
      "the shipped JPEG quality default is 75",
    );
  });

  it("neutralizes device pixel ratio via Emulation.setDeviceMetricsOverride", () => {
    assert.ok(
      indexSource.includes("Emulation.setDeviceMetricsOverride"),
      "must wrap the capture with setDeviceMetricsOverride (DSF=1)",
    );
    assert.ok(
      indexSource.includes("deviceScaleFactor: 1"),
      "override must pin deviceScaleFactor to 1",
    );
    assert.ok(
      indexSource.includes("Emulation.clearDeviceMetricsOverride"),
      "must restore emulation state afterwards (clearDeviceMetricsOverride)",
    );
  });

  it("captures through a bounded clip plan (captureBeyondViewport + clip)", () => {
    assert.ok(
      indexSource.includes("captureBeyondViewport: true"),
      "must capture the viewport region in document space",
    );
    assert.ok(
      indexSource.includes("computeCapturePlan"),
      "must route clip/scale math through computeCapturePlan",
    );
  });

  it("documents the describe_image read path in the tool description", () => {
    const descMatch = indexSource.match(
      /name:\s*"browser_screenshot"[\s\S]{0,1200}?description:\s*((?:"[^"]*"\s*\+?\s*)+)/,
    );
    assert.ok(descMatch, "browser_screenshot registration with description not found");
    const description = descMatch[1].replace(/["+]/g, "");
    assert.ok(
      description.includes("describe_image"),
      "description must tell the agent to read the file via describe_image",
    );
    assert.ok(
      description.includes("details.filePath") || description.includes("filePath"),
      "description must mention the saved file path handoff",
    );
    assert.ok(
      description.includes("quality 75") && description.includes("1440"),
      "description must state the bounded-capture defaults (jpeg-75, <=1440px)",
    );
  });
});

// ── (b) Capture-plan math (pure module) ─────────────────────────────────

const plan = await import(pathToFileURL(CAPTURE_PLAN_TS).href);
const { computeCapturePlan, MAX_SCREENSHOT_DIM, DEFAULT_JPEG_QUALITY } = plan;

describe("computeCapturePlan", () => {
  it("exports MAX_SCREENSHOT_DIM = 1440 and DEFAULT_JPEG_QUALITY = 75", () => {
    assert.equal(MAX_SCREENSHOT_DIM, 1440);
    assert.equal(DEFAULT_JPEG_QUALITY, 75);
  });

  it("keeps a normal viewport unscaled when DSF is neutralized", () => {
    const p = computeCapturePlan(
      { width: 1280, height: 720, dpr: 1, scrollX: 0, scrollY: 0 },
      true,
    );
    assert.equal(p.scale, 1);
    assert.equal(p.captureWidthPx, 1280);
    assert.equal(p.captureHeightPx, 720);
    assert.equal(p.x, 0);
    assert.equal(p.y, 0);
  });

  it("neutralizes Retina (dpr 2) when the DSF override is active — no 2x blowup", () => {
    const p = computeCapturePlan(
      { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0 },
      true,
    );
    assert.equal(p.scale, 1, "scale must not shrink when DSF is already 1");
    assert.equal(p.captureWidthPx, 1280, "output must stay CSS-px sized, not 2x");
    assert.equal(p.captureHeightPx, 800);
  });

  it("compensates Retina via scale when the DSF override is unavailable", () => {
    const p = computeCapturePlan(
      { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0 },
      false,
    );
    assert.equal(p.scale, 0.5, "scale must divide by dpr as best-effort compensation");
    assert.equal(p.captureWidthPx, 1280, "long-edge bound still holds");
  });

  it("bounds a huge viewport to a 1440px long edge", () => {
    const p = computeCapturePlan(
      { width: 3840, height: 2160, dpr: 1, scrollX: 0, scrollY: 0 },
      true,
    );
    assert.ok(Math.abs(p.scale - 1440 / 3840) < 1e-12);
    assert.equal(p.captureWidthPx, 1440);
    assert.equal(p.captureHeightPx, 810);
  });

  it("bounds tall viewports too", () => {
    const p = computeCapturePlan(
      { width: 900, height: 3000, dpr: 1, scrollX: 0, scrollY: 0 },
      true,
    );
    assert.ok(Math.abs(p.scale - 1440 / 3000) < 1e-12);
    assert.equal(p.captureWidthPx, 432);
    assert.equal(p.captureHeightPx, 1440);
  });

  it("expresses the clip origin in document space (scroll offsets)", () => {
    const p = computeCapturePlan(
      { width: 1000, height: 800, dpr: 1, scrollX: 120, scrollY: 340 },
      true,
    );
    assert.equal(p.x, 120);
    assert.equal(p.y, 340);
  });

  it("falls back to defaults for garbage metrics", () => {
    const garbage = { width: NaN, height: 0, dpr: 0, scrollX: NaN, scrollY: -5 };
    const p = computeCapturePlan(garbage, false);
    assert.equal(p.width, 1280, "width falls back to 1280");
    assert.equal(p.height, 720, "height falls back to 720");
    assert.equal(p.scale, 1, "dpr 0 is treated as 1");
    assert.equal(p.x, 0, "NaN scroll falls back to 0");
    assert.equal(p.y, 0, "negative scroll clamps to 0");
  });
});
