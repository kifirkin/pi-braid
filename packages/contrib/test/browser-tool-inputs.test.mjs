/**
 * browser tool inputs: a blank numeric selector means absent, and
 * browser_screenshot's `format` is a closed union.
 *
 * Why this harness exists: pi validates a tool call before a handler runs, and
 * `validateToolArguments` runs TypeBox `Value.Convert` over the raw arguments.
 * Convert turns a blank string into the number 0 for
 * `Type.Optional(Type.Number())` and the converted value then passes the
 * schema check, so an `input.x ?? default` expression cannot tell a blank key
 * from a typed 0. Before the fix a blank `depth` asked Chrome for the document
 * root alone, a blank `timeout` in browser_tabs_wait reported a timeout that
 * never elapsed, a blank settle wait on browser_navigate skipped the wait, and
 * a blank `quality` passed the `typeof` test and clamped to a zero-quality
 * JPEG. browser_screenshot's `format` was prose only, so any unknown value
 * silently became jpeg.
 *
 * Three legs, all offline (no Chrome, no network):
 *   1. schema boundary: the registered browser_screenshot parameters driven
 *      through the framework's own validateToolArguments, including the
 *      blank-to-0 conversion this fix depends on;
 *   2. resolution: every resolver in browser/tool-inputs.ts, one case per
 *      selector shape, each named with its expected outcome;
 *   3. wiring: index.ts routes each of the five sites through its resolver and
 *      carries none of the pre-fix expressions.
 *
 * Run: node packages/contrib/test/browser-tool-inputs.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER = join(HERE, "..", "browser");
const INDEX_TS = join(BROWSER, "index.ts");
const TOOL_INPUTS_TS = join(BROWSER, "tool-inputs.ts");

// The extension reads its toggles and the advanced-tool setting from HOME, so
// it registers against a throwaway tree with the advanced tools on
// (browser_tabs_wait is an advanced tool) and never against the developer's
// own settings.
const HOME = mkdtempSync(join(tmpdir(), "browser-tool-inputs-"));
process.env.HOME = HOME;
mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { contrib: { browserAdvanced: true } } }),
);

// The browser sources import each other with `.js` specifiers that only pi's
// loader resolves, so the same hook the package's other child drivers use is
// registered before any source import.
register(new URL("./lib/ts-resolve.mjs", import.meta.url));

const resolvers = await import(pathToFileURL(TOOL_INPUTS_TS).href);
const extension = await import(pathToFileURL(INDEX_TS).href);
const { validateToolArguments } =
  await import("@earendil-works/pi-ai/utils/validation");

// ── the registered tools, captured from the extension itself ──────────────

const tools = [];
extension.default({
  registerTool: (tool) => tools.push(tool),
  registerCommand: () => {},
  on: () => {},
  setActiveTools: () => {},
});

function tool(name) {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `tool ${name} is not registered`);
  return found;
}

/** Drive raw arguments through the framework's own validation, as pi does. */
function validated(name, args) {
  return validateToolArguments(
    { name, parameters: tool(name).parameters },
    { name, arguments: args },
  );
}

/** The framework's refusal message, or a failure if the call was accepted. */
function refusal(name, args) {
  try {
    validated(name, args);
  } catch (err) {
    return err.message;
  }
  assert.fail(
    `${name} accepted ${JSON.stringify(args)}; validation was supposed to refuse it`,
  );
}

describe("schema boundary through validateToolArguments", () => {
  it("every browser tool is registered, advanced ones included", () => {
    for (const name of [
      "browser_navigate",
      "browser_snapshot",
      "browser_eval",
      "browser_screenshot",
      "browser_tabs_wait",
    ]) {
      assert.ok(tool(name), `tool ${name} is not registered`);
    }
  });

  it("the framework converts a blank numeric key to 0, which is why the handlers cannot trust 0", () => {
    assert.equal(
      validated("browser_screenshot", { quality: "" }).quality,
      0,
      "a blank quality reaches the handler as the number 0",
    );
    assert.equal(
      validated("browser_snapshot", { depth: "" }).depth,
      0,
      "a blank depth reaches the handler as the number 0",
    );
    assert.equal(
      validated("browser_navigate", {
        url: "https://example.com",
        timeout: "",
      }).timeout,
      0,
      "a blank navigate timeout reaches the handler as the number 0",
    );
    assert.equal(
      validated("browser_tabs_wait", { tab_id: "t1", timeout: "" }).timeout,
      0,
      "a blank tabs_wait timeout reaches the handler as the number 0",
    );
  });

  it("an unknown format is refused by the framework, naming the parameter", () => {
    const message = refusal("browser_screenshot", { format: "webp" });
    assert.match(
      message,
      /Validation failed for tool "browser_screenshot"/,
      "the refusal is the framework's own validation error",
    );
    assert.match(
      message,
      /- format:/,
      "the refusal names the format parameter",
    );
  });

  it("a blank format is refused: the union has no blank member", () => {
    assert.match(refusal("browser_screenshot", { format: "" }), /- format:/);
  });

  it("both accepted literals pass validation unchanged", () => {
    assert.equal(
      validated("browser_screenshot", { format: "jpeg" }).format,
      "jpeg",
    );
    assert.equal(
      validated("browser_screenshot", { format: "png" }).format,
      "png",
    );
  });

  it("an absent or null format stays absent, so the handler's jpeg fallback applies", () => {
    assert.equal("format" in validated("browser_screenshot", {}), false);
    assert.equal(
      "format" in validated("browser_screenshot", { format: null }),
      false,
    );
  });

  it("an explicit positive quality and a numeric string both survive as numbers", () => {
    assert.equal(validated("browser_screenshot", { quality: 60 }).quality, 60);
    assert.equal(
      validated("browser_screenshot", { quality: "60" }).quality,
      60,
    );
  });
});

// ── resolution, without a browser ─────────────────────────────────────────

describe("positiveNumber", () => {
  const { positiveNumber } = resolvers;

  it("absent is not a value", () => {
    assert.equal(positiveNumber(undefined), undefined);
    assert.equal(positiveNumber(null), undefined);
  });

  it("a blank string is not a value", () => {
    assert.equal(positiveNumber(""), undefined);
    assert.equal(positiveNumber("  "), undefined);
  });

  it("zero and negatives are not values", () => {
    assert.equal(positiveNumber(0), undefined);
    assert.equal(positiveNumber(-5), undefined);
  });

  it("NaN and Infinity are not values", () => {
    assert.equal(positiveNumber(NaN), undefined);
    assert.equal(positiveNumber(Infinity), undefined);
  });

  it("a numeric string is not parsed: conversion belongs to validation", () => {
    assert.equal(positiveNumber("60"), undefined);
  });

  it("a finite positive number is the value", () => {
    assert.equal(positiveNumber(60), 60);
    assert.equal(positiveNumber(0.5), 0.5);
  });
});

describe("resolveSnapshotDepth", () => {
  const { resolveSnapshotDepth } = resolvers;

  it("absent resolves to -1, the whole subtree", () => {
    assert.equal(resolveSnapshotDepth(undefined), -1);
  });

  it("a blank depth (arriving as 0) resolves to -1, the whole subtree", () => {
    assert.equal(resolveSnapshotDepth(0), -1);
  });

  it("an explicit 0 is read as absent: depth 0 retrieves no children", () => {
    assert.equal(resolveSnapshotDepth(0), -1);
  });

  it("a positive depth is handed to Chrome unchanged", () => {
    assert.equal(resolveSnapshotDepth(8), 8);
  });
});

describe("resolveSnapshotIndent", () => {
  const { resolveSnapshotIndent } = resolvers;

  it("absent resolves to the 10-level render cap", () => {
    assert.equal(resolveSnapshotIndent(undefined), 10);
  });

  it("a blank depth resolves to the 10-level render cap, not a flat tree", () => {
    assert.equal(resolveSnapshotIndent(0), 10);
  });

  it("a positive depth is used as the cap", () => {
    assert.equal(resolveSnapshotIndent(8), 8);
  });
});

describe("resolveNavigateSettleMs", () => {
  const { resolveNavigateSettleMs } = resolvers;

  it("absent settles on 2000ms, the cap the documented 30000 reduces to", () => {
    assert.equal(resolveNavigateSettleMs(undefined), 2000);
  });

  it("a blank timeout resolves to 2000ms instead of skipping the wait", () => {
    assert.equal(resolveNavigateSettleMs(0), 2000);
  });

  it("an explicit 0 is read as absent: a zero settle wait is no wait", () => {
    assert.equal(resolveNavigateSettleMs(0), 2000);
  });

  it("a positive timeout below the cap is honoured", () => {
    assert.equal(resolveNavigateSettleMs(1200), 1200);
  });

  it("a positive timeout above the cap is still capped at 2000ms", () => {
    assert.equal(resolveNavigateSettleMs(9000), 2000);
  });
});

describe("resolveTabsWaitTimeoutMs", () => {
  const { resolveTabsWaitTimeoutMs } = resolvers;

  it("absent resolves to the documented 30000ms", () => {
    assert.equal(resolveTabsWaitTimeoutMs(undefined), 30000);
  });

  it("a blank timeout resolves to 30000ms instead of a deadline of now", () => {
    assert.equal(resolveTabsWaitTimeoutMs(0), 30000);
  });

  it("an explicit 0 is read as absent: a deadline of now is the reported defect", () => {
    assert.equal(resolveTabsWaitTimeoutMs(0), 30000);
  });

  it("a positive timeout is honoured", () => {
    assert.equal(resolveTabsWaitTimeoutMs(5000), 5000);
  });
});

describe("resolveJpegQuality", () => {
  const { resolveJpegQuality } = resolvers;

  it("absent resolves to 75", () => {
    assert.equal(resolveJpegQuality(undefined), 75);
  });

  it("a blank quality resolves to 75 instead of a zero-quality JPEG", () => {
    assert.equal(resolveJpegQuality(0), 75);
  });

  it("an explicit 0 is read as absent: a zero-quality JPEG is not an artifact", () => {
    assert.equal(resolveJpegQuality(0), 75);
  });

  it("a positive quality is clamped exactly as before", () => {
    assert.equal(resolveJpegQuality(60), 60);
    assert.equal(resolveJpegQuality(150), 100);
  });

  it("a fractional positive quality keeps the clamp's own rounding", () => {
    assert.equal(resolveJpegQuality(0.4), 0);
    assert.equal(resolveJpegQuality(0.6), 1);
  });
});

// ── wiring: the sites use the resolvers ───────────────────────────────────

describe("browser/index.ts wiring", () => {
  const source = readFileSync(INDEX_TS, "utf-8");

  it("both CDP depth calls and the render cap come from the snapshot resolvers", () => {
    assert.ok(
      source.includes("const domDepth = resolveSnapshotDepth(input.depth);"),
      "the snapshot handler must resolve its depth once",
    );
    assert.equal(
      source.split("depth: domDepth,").length - 1,
      2,
      "both DOM.getDocument and DOM.getFlattenedDocument must use the resolved depth",
    );
    assert.ok(
      source.includes("resolveSnapshotIndent(input.depth)"),
      "the render cap must use the indent resolver",
    );
  });

  it("the navigate settle wait comes from resolveNavigateSettleMs", () => {
    assert.ok(
      source.includes("resolveNavigateSettleMs(input.timeout)"),
      "browser_navigate must resolve its settle wait",
    );
  });

  it("the tabs_wait budget comes from resolveTabsWaitTimeoutMs", () => {
    assert.ok(
      source.includes("resolveTabsWaitTimeoutMs(params.timeout)"),
      "browser_tabs_wait must resolve its wait budget",
    );
  });

  it("the screenshot quality comes from resolveJpegQuality", () => {
    assert.ok(
      source.includes("resolveJpegQuality(input.quality)"),
      "browser_screenshot must resolve its quality",
    );
  });

  it("none of the pre-fix expressions survives in index.ts", () => {
    for (const stale of [
      "input.depth ??",
      "params.timeout ??",
      "input.timeout ??",
      'typeof input.quality === "number"',
      "DEFAULT_JPEG_QUALITY",
    ]) {
      assert.equal(
        source.includes(stale),
        false,
        `index.ts still contains the pre-fix expression: ${stale}`,
      );
    }
  });
});
