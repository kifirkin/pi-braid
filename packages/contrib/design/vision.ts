/**
 * `visual_judge`: show the rendered page to a vision model and report its answer.
 *
 * The ruler in `./audit.ts` measures geometry. It cannot see cheapness: a page
 * can pass every number it reports and still read as a template, and no
 * contrast ratio says whether the eye knows where to start. This tool puts the
 * full-page PNGs `design_audit` already captures in front of an image-capable
 * model and reports, per width, what that model said, which model said it, the
 * route the request took, the tokens it cost and how long it took.
 *
 * What the answer is: one model's opinion, with the model named. Not a
 * measurement, not a score. Every number in the report is the call's own
 * (tokens, milliseconds); the rubric forbids grades, and the closing line of
 * the report says what the reader is holding.
 *
 * One call per width, not one call for all of them. Each width then carries its
 * own answer, its own usage and its own latency, and a width that fails cannot
 * take the others' answers with it. The cost is N calls for N widths.
 *
 * Refusals, each with the reason the caller needs to act:
 *   - no image-capable model to judge with (the resolution trace is printed,
 *     rung by rung);
 *   - no API key for that model's provider;
 *   - the page would not render (the adapter's own error: a blank page is never
 *     judged);
 *   - a PNG larger than the request limit (that width reports the limit and the
 *     file size, the other widths still run).
 * A provider that answers with an error is reported as that width's error and
 * never retried into a silent success.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  callVision,
  resolveVisionModel,
  searchVisionModel,
  type LlmCallOptions,
  type LlmCallResult,
  type LlmImagePart,
  type VisionModelSearch,
} from "pi-braid/lib";
import { braidDir } from "../state-paths.js";
import { normaliseWidths } from "./audit.js";
import {
  capturePage,
  type CaptureOptions,
  type CaptureResult,
} from "./adapter.js";

/**
 * Largest PNG the tool will send. Providers cap a single image (commonly 5 MB
 * of encoded bytes) and the base64 encoding adds a third on top, so a file
 * above this is refused here rather than spent on a request the provider will
 * reject. A page that needs more height than this is a page to judge in
 * sections, not a page to shrink into illegibility.
 */
const MAX_IMAGE_BYTES = 3_500_000;

/**
 * Per-call ceiling. A judge answer is a few paragraphs; the whole point is a
 * second opinion, not an essay, and a thinking model that spends the budget on
 * reasoning returns an empty text (the report then says so through stopReason).
 */
const JUDGE_MAX_TOKENS = 900;

const JUDGE_TIMEOUT_MS = 180_000;

const DEFAULT_SYSTEM_PROMPT =
  "You review rendered web pages from a screenshot of the page. Answer in prose about " +
  "what the image shows. You cannot measure pixels, contrast ratios or spacing from an " +
  "image, and you must not present numbers as measurements.";

/**
 * The default rubric. It asks for observations a reader can check against the
 * page, names the five things a first-sight judgment can actually see, and
 * forbids the one thing an image cannot support: a score.
 */
const DEFAULT_RUBRIC =
  "Judge this page as a designer seeing it for the first time.\n\n" +
  "First: what is this page, and what is the one action it wants the reader to take?\n" +
  "Then: does it look made for this content, or like a template with the content dropped " +
  "in? Name the detail that decided that.\n" +
  "Then, in this order and separately: hierarchy (is the most important thing the " +
  "largest), type (is there a scale, or is everything one size and weight), spacing " +
  "(does it hold a rhythm), colour, and whether the controls look like controls at this " +
  "width. For each: what is good, what is weak, and the part of the page you are " +
  "judging.\n\n" +
  "Do not give scores, percentages, grades or star ratings: neither of us can measure " +
  "from an image, and a number would look like a measurement. No praise you would not " +
  "defend to the person who built the page.";

export interface VisualJudgeInput {
  /** URL or local HTML path, same target shapes as `design_audit`. */
  target: string;
  widths?: number[];
  /** Where the PNGs land. Defaults to the braid home's design/screenshots. */
  screenshot_dir?: string;
  /** Replaces the default rubric; sent verbatim, then the image caption. */
  rubric?: string;
  timeout_ms?: number;
}

/** The model that answered, named the way a reader can re-use it. */
export interface VisualJudgeModel {
  id: string;
  provider: string;
  api: string;
  /** provider/api: the transport the request actually went through. */
  route: string;
}

/** What one width produced. `answer` and `error` are mutually exclusive. */
export interface JudgeWidthResult {
  width: number;
  screenshot: string | null;
  height: number | null;
  truncated: boolean;
  elapsedMs: number | null;
  usage: { input?: number; output?: number; totalTokens?: number } | null;
  /** Provider stop reason when it was not a normal stop (e.g. "length"). */
  stopReason: string | null;
  answer: string | null;
  error: string | null;
}

export interface VisualJudgeResult {
  target: string;
  model: VisualJudgeModel | null;
  /** Which rung of the resolution supplied the model. */
  modelSource: VisionModelSearch["source"];
  /** The resolution's trace, in order, kept for the report and refusal text. */
  modelTried: string[];
  /** True when the caller supplied the rubric rather than the tool's default. */
  customRubric: boolean;
  widths: JudgeWidthResult[];
  /** Total tokens reported by every call that answered. */
  totals: { input: number; output: number; elapsedMs: number };
  text: string;
}

/**
 * The seams this tool reads the outside world through. Production defaults are
 * the real adapter, the real resolver and the real vision call; a test supplies
 * all of them, so the tool's own decisions (order, refusals, what is reported)
 * are testable with no browser, no network and no key.
 */
export interface VisualJudgeDeps {
  /** `resolveVisionModel` in production: the single model a vision call uses. */
  resolveModel(ctx: ExtensionContext): Model<Api> | undefined;
  /** `searchVisionModel` in production: the same walk, with its trace. */
  explainModel(ctx: ExtensionContext): VisionModelSearch;
  capture(target: string, options: CaptureOptions): Promise<CaptureResult>;
  judge(
    model: Model<Api>,
    apiKey: string | undefined,
    systemPrompt: string,
    instruction: string,
    images: readonly LlmImagePart[],
    options: Omit<LlmCallOptions, "images">,
  ): Promise<LlmCallResult>;
  apiKeyFor(ctx: ExtensionContext, provider: string): Promise<string | null>;
  /** Monotonic milliseconds. `performance.now`, never `Date.now`: elapsed time
   * must not jump when the wall clock is corrected mid-call. */
  now(): number;
}

/** One shared definition, so this tool and `design_audit` cannot drift apart. */
export function defaultScreenshotDir(): string | null {
  const root = braidDir();
  return root === null ? null : join(root, "design", "screenshots");
}

const DEFAULT_DEPS: VisualJudgeDeps = {
  resolveModel: resolveVisionModel,
  explainModel: searchVisionModel,
  capture: capturePage,
  judge: callVision,
  apiKeyFor: async (ctx, provider) =>
    (await ctx.modelRegistry
      .getApiKeyForProvider(provider)
      .catch(() => null)) ?? null,
  now: () => performance.now(),
};

/**
 * The instruction for one image: the rubric, then a caption saying what the
 * model is looking at. The width is in the caption because a judgment of a
 * phone layout and a judgment of a desktop layout are different judgments, and
 * a model told nothing about scale will describe a 320px page as a cramped
 * desktop.
 */
function instructionFor(
  rubric: string,
  width: number,
  height: number | null,
  truncated: boolean,
): string {
  const size =
    height === null ? "full height" : `full height, ${height}px tall`;
  const cut = truncated
    ? ", truncated at the capture limit: anything below the cut is not in the image"
    : "";
  return `${rubric}\n\nThe image is this page rendered at ${width}px wide (${size}${cut}).`;
}

function renderJudge(result: VisualJudgeResult, rubricKind: string): string {
  const lines: string[] = [];
  lines.push(`## visual_judge: ${result.target}`);
  lines.push("");
  if (result.model !== null) {
    lines.push(
      `Model: ${result.model.provider}/${result.model.id} (route ${result.model.route}, ` +
        `resolved from ${describeSource(result.modelSource)})`,
    );
  }
  lines.push(`Rubric: ${rubricKind}`);
  lines.push(
    `Widths: ${result.widths.map((width) => width.width).join(", ")} px, one call each`,
  );
  lines.push("");

  for (const entry of result.widths) {
    const cost =
      entry.usage === null
        ? "no usage reported"
        : `${entry.usage.input ?? "?"} in / ${entry.usage.output ?? "?"} out tokens`;
    const timing =
      entry.elapsedMs === null
        ? "not called"
        : `${(entry.elapsedMs / 1000).toFixed(1)}s`;
    const stop =
      entry.stopReason !== null && entry.stopReason !== "stop"
        ? `, stopReason ${entry.stopReason}`
        : "";
    lines.push(`### ${entry.width}px (${timing}, ${cost}${stop})`);
    if (entry.answer !== null) {
      lines.push("");
      lines.push(entry.answer.trim());
    } else {
      lines.push("");
      lines.push(`Not judged: ${entry.error ?? "the model returned no text"}`);
    }
    if (entry.truncated) {
      lines.push("");
      lines.push(
        `Screenshot truncated at ${entry.height ?? "?"}px: the model saw the top of the page only.`,
      );
    }
    lines.push("");
  }

  const judged = result.widths.filter((entry) => entry.answer !== null).length;
  const failed = result.widths.length - judged;
  if (failed > 0) {
    lines.push(
      `${failed} of ${result.widths.length} widths were not judged; each one names its reason above.`,
    );
    lines.push("");
  }
  lines.push(
    `Judged by ${result.model === null ? "no model" : `${result.model.provider}/${result.model.id}`}: ` +
      `${result.totals.input} in / ${result.totals.output} out tokens over ` +
      `${(result.totals.elapsedMs / 1000).toFixed(1)}s of model time.`,
  );
  lines.push(
    "What this is: one model's opinion of the rendered page, with the model named. It is " +
      "not a measurement; `design_audit` reports the geometry.",
  );
  return lines.join("\n");
}

function describeSource(source: VisionModelSearch["source"]): string {
  switch (source) {
    case "current":
      return "the session model";
    case "utilityModel":
      return "the utility model";
    case "available":
      return "the available models (no utility model configured or usable)";
    default:
      return "nothing";
  }
}

/**
 * The whole judge, with the tool wrapper removed, so a smoke run drives the
 * same path a session does. Throws on the refusals that stop the run before any
 * image is sent; a width that fails afterwards is reported in its own entry.
 */
export async function runVisualJudge(
  input: VisualJudgeInput,
  ctx: ExtensionContext,
  deps: VisualJudgeDeps = DEFAULT_DEPS,
): Promise<VisualJudgeResult> {
  const widths = normaliseWidths(input.widths, "visual_judge");
  const target = (input.target ?? "").trim();
  if (target === "") throw new Error("target is empty");

  const model = deps.resolveModel(ctx);
  const search = deps.explainModel(ctx);
  if (model === undefined) {
    throw new Error(
      "no image-capable model to judge with. Tried: " +
        `${search.tried.join("; ")}. Set one with /utility-model <provider/model>, or ` +
        "select a session model that accepts image input.",
    );
  }

  const apiKey = await deps.apiKeyFor(ctx, model.provider);
  if (apiKey === null || apiKey === undefined || apiKey === "") {
    throw new Error(
      `no API key for provider ${model.provider}, which serves ${model.provider}/${model.id}. ` +
        "Authenticate that provider, or point the utility model at one that has a key.",
    );
  }

  const screenshotDir =
    typeof input.screenshot_dir === "string" &&
    input.screenshot_dir.trim() !== ""
      ? input.screenshot_dir.trim()
      : defaultScreenshotDir();
  if (screenshotDir === null) {
    throw new Error(
      "no screenshot directory: the tool needs the PNGs it sends, and no braid state root " +
        "could be derived. Pass screenshot_dir.",
    );
  }

  // Render before judging. A page that will not load throws here, out of the
  // adapter, and no model is asked to describe an error page.
  const captured = await deps.capture(target, {
    widths,
    screenshotDir,
    timeoutMs: input.timeout_ms,
  });

  const customRubric =
    typeof input.rubric === "string" && input.rubric.trim() !== "";
  const rubric = customRubric
    ? (input.rubric as string).trim()
    : DEFAULT_RUBRIC;

  const results: JudgeWidthResult[] = [];
  const totals = { input: 0, output: 0, elapsedMs: 0 };

  for (const entry of captured.widths) {
    const width = entry.snapshot.viewportWidth;
    const shot = entry.screenshot;
    const base: JudgeWidthResult = {
      width,
      screenshot: shot?.path ?? null,
      height: shot?.height ?? null,
      truncated: shot?.truncated ?? false,
      elapsedMs: null,
      usage: null,
      stopReason: null,
      answer: null,
      error: null,
    };

    if (shot === null) {
      results.push({
        ...base,
        error: `no screenshot was captured at ${width}px`,
      });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(shot.path);
    } catch (error) {
      results.push({
        ...base,
        error: `the screenshot at ${shot.path} could not be read: ${(error as Error).message}`,
      });
      continue;
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      results.push({
        ...base,
        error:
          `${shot.path} is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte limit ` +
          "for one image. Judge a narrower width or a shorter page.",
      });
      continue;
    }

    const instruction = instructionFor(
      rubric,
      width,
      shot.height,
      shot.truncated,
    );
    const started = deps.now();
    let answer: LlmCallResult;
    try {
      answer = await deps.judge(
        model,
        apiKey,
        DEFAULT_SYSTEM_PROMPT,
        instruction,
        [{ data: bytes.toString("base64"), mimeType: "image/png" }],
        {
          maxTokens: JUDGE_MAX_TOKENS,
          temperature: 0.2,
          timeoutMs: JUDGE_TIMEOUT_MS,
          // A judge reads an image; extended thinking buys nothing here and
          // spends the same output budget the answer comes out of.
          reasoning: "off",
        },
      );
    } catch (error) {
      answer = { error: (error as Error).message };
    }
    const elapsedMs = Math.round(deps.now() - started);

    if ("error" in answer) {
      results.push({ ...base, elapsedMs, error: answer.error });
      continue;
    }
    const usage = answer.usage ?? null;
    totals.input += usage?.input ?? 0;
    totals.output += usage?.output ?? 0;
    totals.elapsedMs += elapsedMs;
    // An answer with no text is not an answer: a model that spent its whole
    // budget on reasoning returns an empty string with stopReason "length", and
    // rendering that as "the model said nothing about this width" is exactly the
    // silent blank this report exists to prevent.
    const answered = answer.text.trim() !== "";
    results.push({
      ...base,
      elapsedMs,
      usage,
      stopReason: answer.stopReason ?? null,
      answer: answered ? answer.text : null,
      error: answered ? null : "the model returned no text",
    });
  }

  const judged: VisualJudgeResult = {
    target: captured.target,
    model: {
      id: model.id,
      provider: model.provider,
      api: model.api,
      route: `${model.provider}/${model.api}`,
    },
    modelSource: search.source,
    modelTried: search.tried,
    customRubric,
    widths: results,
    totals,
    text: "",
  };
  judged.text = renderJudge(
    judged,
    customRubric ? "caller's, sent verbatim" : "default",
  );
  return judged;
}
