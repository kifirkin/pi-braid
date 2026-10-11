// Bounded chunked summarization.
//
// One summarization request that swallows an oversized span dies on the output
// token cap: pi-ai clamps the request's max_tokens to window - estimate(prompt)
// - 4096 (simple-options.js:6-12), and a 185-message span in one call with
// xhigh reasoning billed inside the same budget is length-stopped before the
// summary completes ("Summarization failed: generation hit the token cap and
// the summary is incomplete"). This module owns the bounded alternative: split
// the span into units (an assistant tool-call turn glued to its toolResults),
// pack the units into chunks under a per-call input cap, and summarize
// successively — each chunk's prompt carries the running summary, the previous
// compaction summary, and the user anchor, and its output becomes the next
// running summary. Every request is then bounded on both the input side (chunk
// cap) and the output side (its own fixed budget, reasoning off).
//
// The fold grows: each call's output becomes the next call's running summary,
// so a span whose accumulated summary reaches the output budget length-stops
// every later chunk no matter how small that chunk's own input is. Splitting a
// chunk's INPUT cannot shrink the FOLD, so a fold that survives its own
// rewrite burns the call budget down to a single unit and aborts. A
// length-stop on a material fold therefore runs the fold-shrink rung first:
// one bounded rewrite attempt (accepted only when it is not itself
// length-stopped and keeps at least half the fold), then - whichever way the
// rewrite went - a deterministic head-and-tail reduction that lands the fold
// strictly below CHUNK_FOLD_TARGET_TOKENS with no model call and names the
// elision in the summary. The retry merge then cannot hit the same fold wall.
// Only when the fold is not the cause (below the material share) does the
// ladder split the chunk's units (the content-dense class the split recovers,
// 60-unit chunks into 30+30) or accept the partial merge, keeping the running
// fold untouched when that partial text is shorter than the fold. Only a call
// budget exhausted with work left is a summary-cap failure.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { estimateMessagesTokens, resolveWindow } from "../../../../lib/detection/context-usage.js";
import { callLlm } from "../../../../lib/ai/llm-call.js";
import { log, getCmState } from "./shared.js";
import { notifyCompactionProgress } from "./compaction-watchdog.js";

/**
 * A fold this large (as a share of the merge budget) is a plausible cause of a
 * length-stop on its own: at a quarter of the budget the accumulated summary
 * can consume the whole generation before the new part is merged in. Below
 * the share the fold cannot be the reason, so the ladder goes straight to the
 * unit split.
 */
export const CHUNK_FOLD_MATERIAL_SHARE = 0.25;

/** Max messages in one summarization call's chunk. */
export const CHUNK_MAX_MESSAGES = 60;

/**
 * Per-call input cap as a share of the context window. The call must coexist
 * with its own output budget and the rest of the request pipeline inside the
 * window; a quarter of the window keeps the serialized chunk an order below
 * the request clamp for every realistic window.
 */
export const CHUNK_INPUT_TOKEN_FRACTION = 0.25;

/** Floor for the per-call input cap so tiny windows still get usable chunks. */
export const CHUNK_MIN_INPUT_TOKENS = 8192;

/** Fixed output budget per chunk call (a chunk summary is a bounded artifact).
 *
 * Raised from 4096: a dense 60-message chunk is ~23.6K input tokens of
 * preserved paths, identifiers, and error text to fold into a running
 * summary; 4096 output tokens is smaller than that demand for exactly the
 * spans this path serves, so the cap fired deterministically on the live
 * 750-message range archive. 8192 keeps the per-call total (input <= a
 * quarter-window + this output + pipeline overhead) far under the request
 * clamp for every realistic window while roughly doubling the summary
 * headroom. A raised constant moves the threshold; the mechanism that
 * removes the failure class is the length-stop ladder in summarizeSpanInChunks
 * (fold compression, then unit split, then partial acceptance).
 */
export const CHUNK_SUMMARY_MAX_TOKENS = 8192;

/**
 * Output budget for one fold-compression rewrite. A rewrite is not a merge: it
 * must only shrink the running summary while preserving structure and verbatim
 * identifiers, so its budget stays far below the merge budget - a 2048-token
 * fold leaves the 8192-token merge ample output headroom.
 */
export const CHUNK_FOLD_COMPRESS_MAX_TOKENS = 2048;

/**
 * A fold-compression rewrite is accepted only when it is not itself
 * length-stopped AND keeps at least this share of the running fold. A shorter
 * rewrite either dropped most of the fold or was cut by its own output budget
 * (a length stop consumed as success is exactly the silent loss the acceptance
 * rung's length rule closes one rung later). A refused rewrite keeps the fold
 * and falls through to the unit split.
 */
export const CHUNK_FOLD_MIN_KEEP_SHARE = 0.5;

/**
 * Token count at which the running fold is treated as the cause of a
 * length-stop: at or above it the accumulated summary can consume the whole
 * merge generation on its own. The fold-shrink rung must leave the fold
 * STRICTLY below this count before the merge is retried, or the same
 * length-stop repeats and the cycle burns its call budget without shrinking
 * the fold. Named once here; both the discriminator and the deterministic
 * reduction read it.
 */
export const CHUNK_FOLD_TARGET_TOKENS = Math.floor(
  CHUNK_SUMMARY_MAX_TOKENS * CHUNK_FOLD_MATERIAL_SHARE,
);

/** Chars per token used to compare a fold's length against the token target. */
export const CHUNK_FOLD_CHARS_PER_TOKEN = 4;

/** Hard ceiling on chunk count; beyond it the caller falls back to pi-core. */
export const CHUNK_COUNT_MAX = 16;

/** Per-call timeout: bounded input + fixed output must settle far below it. */
export const CHUNK_CALL_TIMEOUT_MS = 180_000;

/**
 * Hard bound on total callLlm invocations across one summarizeSpanInChunks
 * run, split retries included. The base chain is <=
 * CHUNK_COUNT_MAX calls; every capped chunk adds its halves to the worklist,
 * so without a stated bound a pathological all-cap span recurses
 * unbounded. Exceeding the budget returns the honest summary-cap failure
 * (no fall-through); the compaction retry ladder owns the next move.
 */
export const CHUNK_SPLIT_CALL_BUDGET = 64;

interface SpanChunk {
  messages: unknown[];
  estimatedTokens: number;
}

/**
 * Group a span's messages into units that must not be split across chunks: an
 * assistant message carrying toolCall blocks is glued to every immediately
 * following toolResult message, so a call and its results stay in one chunk
 * (a chunk boundary between them would produce summaries that reference
 * results they never saw).
 */
export function groupIntoUnits(messages: readonly unknown[]): unknown[][] {
  const units: unknown[][] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i] as { role?: string; content?: unknown } | undefined;
    const hasToolCalls =
      message?.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (c: { type?: string }) => c && typeof c === "object" && c.type === "toolCall",
      );
    if (!hasToolCalls) {
      units.push([messages[i]]);
      i++;
      continue;
    }
    const unit: unknown[] = [messages[i]];
    i++;
    while (i < messages.length) {
      const next = messages[i] as { role?: string } | undefined;
      if (next?.role !== "toolResult") break;
      unit.push(next);
      i++;
    }
    units.push(unit);
  }
  return units;
}

/**
 * Pack units into chunks under the per-call input cap and the per-chunk
 * message cap. Returns null when the span needs more chunks than
 * CHUNK_COUNT_MAX — the caller then falls back to the default path instead of
 * silently unbounding a call. A single unit whose own estimate exceeds the cap
 * becomes its own chunk: the serialized text is typically smaller than the raw
 * estimate (toolResults truncate at 2000 chars), so honesty beats silence.
 */
export function planChunks(
  messages: readonly unknown[],
  contextWindow: number,
): SpanChunk[] | null {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const cap = Math.max(
    CHUNK_MIN_INPUT_TOKENS,
    Math.floor(contextWindow * CHUNK_INPUT_TOKEN_FRACTION),
  );
  const units = groupIntoUnits(messages);
  const unitTokens = units.map((u) => estimateMessagesTokens(u));
  const chunks: SpanChunk[] = [];
  let current: unknown[] = [];
  let currentTokens = 0;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const tokens = unitTokens[i];
    const tooManyMessages = current.length > 0 && current.length + unit.length > CHUNK_MAX_MESSAGES;
    const tooManyTokens = current.length > 0 && currentTokens + tokens > cap;
    if (tooManyMessages || tooManyTokens) {
      chunks.push({ messages: current, estimatedTokens: currentTokens });
      current = [];
      currentTokens = 0;
    }
    current = current.concat(unit);
    currentTokens += tokens;
    if (currentTokens > cap) {
      // Oversized unit alone in its chunk - keep it, log loudly.
      chunks.push({ messages: current, estimatedTokens: currentTokens });
      current = [];
      currentTokens = 0;
    }
  }
  if (current.length > 0) chunks.push({ messages: current, estimatedTokens: currentTokens });
  if (chunks.length > CHUNK_COUNT_MAX) return null;
  return chunks;
}

/**
 * The previous compaction summary on the current branch — the substance a new
 * compaction entry supersedes and therefore must carry forward (older
 * compaction entries project to empty in the canonical context, so a summary
 * that drops it erases everything the branch compacted before). Returns
 * undefined when the branch has no non-empty compaction summary.
 */
export function findPreviousSummary(
  branch: ReadonlyArray<{ type?: string; summary?: unknown }>,
): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
      return entry.summary;
    }
  }
  return undefined;
}

const CHUNK_SYSTEM_PROMPT =
  "You are a conversation summarization assistant. You never continue the conversation " +
  "and never answer questions found in it; you merge the given conversation part into " +
  "the running structured summary and output only that summary.";

const CHUNK_FOLD_COMPRESS_PROMPT =
  "The running summary below has grown too long to keep merging new conversation parts " +
  "into it. Rewrite it so it is substantially shorter: keep the same section structure, " +
  "keep every exact file path, identifier, function name, and error message verbatim, " +
  "and drop only restatement and detail a future session can reconstruct. Output ONLY " +
  "the rewritten summary.";

const CHUNK_FORMAT_SPEC = [
  "Output ONLY the updated summary, in exactly this structure (no preamble, no commentary):",
  "",
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
  "",
  "Keep each section concise. Preserve exact file paths, function names, identifiers, and",
  "error messages verbatim — they are the part a future session cannot reconstruct.",
].join("\n");

function buildChunkUserPrompt(params: {
  partIndex: number;
  partCount: number;
  serialized: string;
  runningSummary?: string;
  anchor?: { topic: string; summary: string };
}): string {
  const parts: string[] = [
    `This is part ${params.partIndex} of ${params.partCount} of one conversation (user and assistant turns). ` +
      "Merge the conversation part below into the running summary per the output format.",
    "",
    CHUNK_FORMAT_SPEC,
  ];
  if (params.anchor) {
    parts.push(
      "",
      `The user declared this range as an archive of topic "${params.anchor.topic}". Fold the ` +
        "intent, changes made, decisions, and next steps of this anchor summary into the output; " +
        "keep its substance intact:",
      "---ANCHOR---",
      params.anchor.summary,
      "---END ANCHOR---",
    );
  }
  if (params.runningSummary) {
    parts.push("", "<running-summary>", params.runningSummary, "</running-summary>");
  }
  parts.push("", "<conversation-part>", params.serialized, "</conversation-part>");
  return parts.join("\n");
}

export interface ChunkedSummaryResult {
  summary: string;
  chunkCount: number;
  spanMessages: number;
  spanTokens: number;
  usage: Usage | undefined;
}

/**
 * One bounded fold-compression call: rewrite the accumulated running summary
 * shorter so the next merge has output headroom. The raw text and its stop
 * reason are returned; the ladder owns the accept/refuse decision, because it
 * holds the fold length the keep floor is measured against and knows how to
 * continue when the rewrite is refused.
 */
async function compressRunningSummary(params: {
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string | undefined;
  running: string;
  signal?: AbortSignal;
}): Promise<{ text: string; stopReason?: string } | { error: string }> {
  const prompt = [
    CHUNK_FOLD_COMPRESS_PROMPT,
    "",
    "<running-summary>",
    params.running,
    "</running-summary>",
  ].join("\n");
  const result = await callLlm(params.model, params.apiKey, CHUNK_SYSTEM_PROMPT, prompt, {
    maxTokens: CHUNK_FOLD_COMPRESS_MAX_TOKENS,
    reasoning: "off",
    timeoutMs: CHUNK_CALL_TIMEOUT_MS,
    signal: params.signal,
  });
  if ("error" in result) return { error: `fold compression failed: ${result.error}` };
  const text = (result.text ?? "").trim();
  if (!text) return { error: "fold compression returned an empty rewrite" };
  return { text, stopReason: result.stopReason };
}

/**
 * Deterministic fold reduction: the floor of the fold-shrink rung. Keep a
 * bounded head and tail of the running summary, elide the middle, and name
 * the loss inline with the existing `[note: ...]` convention. No model call,
 * so it always runs and always lands the fold strictly below
 * {@link CHUNK_FOLD_TARGET_TOKENS}: a fold the model would not rewrite shorter
 * can still be made to fit by construction, and the note states what was
 * dropped (the full fold stays in the append-only session file).
 *
 * The character budget is one token below the target because the token count
 * is `ceil(chars / CHUNK_FOLD_CHARS_PER_TOKEN)`: `(target - 1) * charsPerToken`
 * chars still round to `target - 1` tokens, below the material share. The note
 * is sized for a 12-digit elided count, which bounds any real fold.
 */
function reduceFoldDeterministically(
  fold: string,
  logPrefix: string,
  partIndex: number,
): { text: string; elidedChars: number } {
  const targetChars = (CHUNK_FOLD_TARGET_TOKENS - 1) * CHUNK_FOLD_CHARS_PER_TOKEN;
  const notePrefix = "\n\n[note: ";
  const noteSuffix =
    " characters from the middle of the running summary were elided deterministically " +
    "(head and tail kept) to bring the fold below its budget; the elided text stays in " +
    "the append-only session file.]\n\n";
  const maxNoteChars = notePrefix.length + noteSuffix.length + 12;
  const side = Math.max(1, Math.floor((targetChars - maxNoteChars) / 2));
  const head = fold.slice(0, side);
  const tail = fold.slice(Math.max(side, fold.length - side));
  const elidedChars = Math.max(0, fold.length - head.length - tail.length);
  const text = `${head}${notePrefix}${elidedChars}${noteSuffix}${tail}`;
  log.warn(
    `[context-manager] ${logPrefix} chunk ${partIndex}: the running fold could not be shrunk by ` +
      `rewrite - eliding ${elidedChars} characters from its middle deterministically ` +
      `(${fold.length} -> ${text.length} chars, target <${CHUNK_FOLD_TARGET_TOKENS} tokens)`,
  );
  return { text, elidedChars };
}

/**
 * The fold-shrink rung: the ladder's guarantee that a material fold can
 * always be reduced. One bounded rewrite attempt, then - whether the rewrite
 * landed, was refused, or no call budget remained for it - the deterministic
 * reduction. Returns a fold strictly below {@link CHUNK_FOLD_TARGET_TOKENS}.
 * `refused` names a rewrite that did not land (the summary note reports it);
 * `elidedChars` reports the deterministic loss; `calls` is the rewrite call
 * count for the caller's budget.
 */
async function shrinkRunningFold(params: {
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string | undefined;
  running: string;
  signal?: AbortSignal;
  logPrefix: string;
  partIndex: number;
  partCount: number;
  canCallLlm: boolean;
}): Promise<{ text: string; refused: boolean; elidedChars: number; calls: number }> {
  let fold = params.running;
  let refused = false;
  let calls = 0;
  const foldTokens = () => Math.ceil(fold.length / CHUNK_FOLD_CHARS_PER_TOKEN);
  if (foldTokens() >= CHUNK_FOLD_TARGET_TOKENS) {
    if (params.canCallLlm) {
      calls++;
      const compressed = await compressRunningSummary({
        model: params.model,
        apiKey: params.apiKey,
        running: fold,
        signal: params.signal,
      });
      if ("error" in compressed) {
        refused = true;
        log.warn(
          `[context-manager] ${params.logPrefix} fold compression did not land (${compressed.error}) - ` +
            `reducing the fold deterministically instead`,
        );
      } else {
        const minKeep = Math.floor(fold.length * CHUNK_FOLD_MIN_KEEP_SHARE);
        const stoppedAtLength = compressed.stopReason === "length";
        const belowKeepFloor = compressed.text.length < minKeep;
        if (stoppedAtLength || belowKeepFloor) {
          refused = true;
          log.warn(
            `[context-manager] ${params.logPrefix} fold compression refused (` +
              (stoppedAtLength
                ? "the rewrite was length-stopped"
                : `the ${compressed.text.length}-char rewrite is below the ${minKeep}-char keep floor`) +
              `) - reducing the fold deterministically instead`,
          );
        } else {
          log.warn(
            `[context-manager] ${params.logPrefix} chunk ${params.partIndex}/${params.partCount} hit the ` +
              `output cap with a ${foldTokens()}-token fold - compressing the running summary once and ` +
              `retrying the merge`,
          );
          fold = compressed.text;
        }
      }
    } else {
      refused = true;
      log.warn(
        `[context-manager] ${params.logPrefix} fold compression skipped (call budget spent) - ` +
          `reducing the fold deterministically instead`,
      );
    }
  }
  let elidedChars = 0;
  if (foldTokens() >= CHUNK_FOLD_TARGET_TOKENS) {
    const reduced = reduceFoldDeterministically(fold, params.logPrefix, params.partIndex);
    fold = reduced.text;
    elidedChars = reduced.elidedChars;
  }
  return { text: fold, refused, elidedChars, calls };
}

/** Error variant of the chunked summary. failureClass marks the cycle's
 * failure class where the chunked path itself knows it (today only the
 * summary-cap class); callers route on it instead of re-parsing the text. */
export interface ChunkedSummaryError {
  error: string;
  failureClass?: "summary-cap";
}

/**
 * Test seam: force the chunked summary to report a class without running the
 * chain. Mirrors the codebase's other __set*ForTest seams. The controller's
 * never-block rung (the deterministic cut after a bounded summarizer failure)
 * is otherwise unreachable from a test: the length-stop ladder completes a
 * chain in-process instead of failing the cycle.
 */
let forcedFailureForTest: "summary-cap" | null = null;
export function __setChunkedSummaryFailureForTest(failure: "summary-cap" | null): void {
  forcedFailureForTest = failure;
}

/**
 * Test seam: the deterministic fold reduction in isolation, so a fixture can
 * assert the guarantee without driving a whole chain (the fold it returns is
 * the one the rung lands; the stub cannot observe the fold at retry time).
 */
export function __reduceFoldForTest(fold: string): { text: string; elidedChars: number } {
  return reduceFoldDeterministically(fold, "test-fold-reduce", 1);
}

/**
 * Summarize a span in bounded chunks with reasoning off, split-on-cap: a
 * chunk whose generation is length-stopped splits into two unit-halves that
 * re-enter the worklist and retry (the whole-chain abort on one capped chunk
 * is gone), under the hard CHUNK_SPLIT_CALL_BUDGET. Returns the final merged
 * summary, or { error, failureClass? }; a summary-cap-class failureClass
 * tells the caller to fail the cycle honestly — never to hand the span to
 * pi-core's unbounded single-call summarizer, which is the one recovery that
 * cannot work for the class that made the bounded path necessary. Abort
 * honesty: a watchdog cancel between chunks stops the chain instead of
 * feeding a dead cycle.
 */
export async function summarizeSpanInChunks(params: {
  ctx: ExtensionContext;
  span: readonly unknown[];
  anchor?: { topic: string; summary: string };
  /** Summary from the previous compaction (pi-core's prepared previousSummary); falls back to a branch walk. */
  previousSummary?: string;
  /** Cycle abort signal (session_before_compact carries pi-core's compaction controller). */
  signal?: AbortSignal;
  logPrefix: string;
}): Promise<ChunkedSummaryResult | ChunkedSummaryError> {
  const { ctx, span, anchor, signal, logPrefix } = params;
  if (forcedFailureForTest) {
    return {
      error: `forced ${forcedFailureForTest} failure (test seam)`,
      failureClass: forcedFailureForTest,
    };
  }
  const model = ctx.model;
  if (!model) return { error: "no model available for the chunked summary" };
  const window = resolveWindow(ctx?.model?.contextWindow).contextWindow;
  const chunks = planChunks(span, window);
  if (!chunks) {
    return {
      error: `span needs more than ${CHUNK_COUNT_MAX} chunks (est. ${estimateMessagesTokens(span)} tokens) - not chunkable within the bounded call shape`,
    };
  }
  if (chunks.length === 0) return { error: "empty span" };

  let apiKey: string | undefined;
  try {
    apiKey = await (
      ctx.modelRegistry as
        | {
            getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
          }
        | undefined
    )?.getApiKeyForProvider?.(model.provider);
  } catch {
    apiKey = undefined; // degraded auth - the call will surface its own error
  }

  let running: string | undefined = params.previousSummary;
  if (!running) {
    try {
      const branch =
        (
          ctx.sessionManager as { getBranch?: () => Array<{ type?: string; summary?: unknown }> }
        ).getBranch?.() ?? [];
      running = findPreviousSummary(branch);
    } catch {
      running = undefined;
    }
  }

  const spanMessages = span.length;
  const spanTokens = estimateMessagesTokens(span);
  // callLlm reports only input/output/totalTokens (no cache/cost fields), so
  // the accumulated usage zero-fills those and the report states the gap.
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let usageSeen = false;

  // Worklist of remaining chunks. A length-stopped chunk splits into two
  // unit-halves that re-enter the FRONT of the list (sequential chain, the
  // running-summary fold stays order-preserving) and retry — the split-on-cap
  // mechanism. callsUsed counts every callLlm invocation against
  // CHUNK_SPLIT_CALL_BUDGET; partIndex/partCount track the live worklist so
  // the prompt's "part X of Y" stays true after splits.
  const pending: SpanChunk[] = chunks.slice();
  let callsUsed = 0;
  let completed = 0;
  // Parts whose generation was cut before it reproduced the running fold: the
  // span is still covered by the session file, but this summary does not carry
  // them, and saying so is the honest half of the acceptance rule.
  const unmergedParts: number[] = [];
  // Parts whose fold-compression rewrite was refused (length-stopped or below
  // the keep floor): the fold was reduced deterministically there, and the
  // note must distinguish that from a compression that landed.
  const refusedFoldParts: number[] = [];
  // Parts whose fold was elided by the deterministic reduction, with the
  // characters dropped from its middle. The note names the loss.
  const elidedFoldParts: { part: number; elided: number }[] = [];

  while (pending.length > 0) {
    try {
      if (getCmState(ctx).cancelSource === "watchdog") {
        return { error: "chunked summary aborted mid-chain (watchdog cancel)" };
      }
    } catch {
      /* state unavailable - continue the chain */
    }
    if (callsUsed >= CHUNK_SPLIT_CALL_BUDGET) {
      return {
        error:
          `split call budget exhausted after ${callsUsed} call(s) ` +
          `(${completed} chunk summary(ies) landed) - span not chunkable within the bounded call shape`,
        failureClass: "summary-cap",
      };
    }
    const chunk = pending.shift() as SpanChunk;
    const partCount = completed + pending.length + 1;
    const partIndex = completed + 1;
    const serialized = serializeSpanForChunk(chunk.messages);
    const prompt = buildChunkUserPrompt({
      partIndex,
      partCount,
      serialized,
      runningSummary: running,
      anchor,
    });
    log.info(
      `[context-manager] ${logPrefix} chunk ${partIndex}/${partCount}: ` +
        `${chunk.messages.length} msgs, ~${chunk.estimatedTokens} tokens est, ` +
        `maxTokens ${CHUNK_SUMMARY_MAX_TOKENS}, reasoning off`,
    );
    const result = await callLlm(model, apiKey, CHUNK_SYSTEM_PROMPT, prompt, {
      maxTokens: CHUNK_SUMMARY_MAX_TOKENS,
      reasoning: "off",
      timeoutMs: CHUNK_CALL_TIMEOUT_MS,
      signal,
    });
    callsUsed++;
    if ("error" in result) {
      return { error: `chunk ${partIndex}/${partCount} failed: ${result.error}` };
    }
    const text = (result.text ?? "").trim();
    if (!text) {
      return { error: `chunk ${partIndex}/${partCount} returned an empty summary` };
    }
    if (result.stopReason === "length") {
      // Two distinct causes wear the same stopReason and need opposite
      // recoveries. (i) The FOLD overflowed the output budget: the generation
      // IS the merged running summary ("output only that summary"), so once
      // the fold approaches the merge budget every later chunk length-stops no
      // matter how small its own input is - splitting that input cannot shrink
      // the fold. (ii) The CHUNK CONTENT is too dense for one call's output
      // budget (many units, a small fold), where the unit split is the proven
      // recovery (60-unit chunks split 30+30 complete). Discriminate on the
      // fold's own size against the
      // merge budget. A material fold runs the fold-shrink rung, which always
      // lands the fold strictly below the material share (a rewrite that did
      // not land is followed by the deterministic reduction), so the retry
      // merge cannot wall on the same fold. A non-material fold goes straight
      // to the unit split or the partial acceptance. Nothing here aborts the
      // cycle.
      const units = groupIntoUnits(chunk.messages);
      const foldChars = (running ?? "").length;
      const foldTokens = Math.ceil(foldChars / CHUNK_FOLD_CHARS_PER_TOKEN);
      const foldIsMaterial = foldTokens >= CHUNK_FOLD_TARGET_TOKENS;
      if (foldIsMaterial && (running ?? "").trim()) {
        const shrink = await shrinkRunningFold({
          model,
          apiKey,
          running: running ?? "",
          signal,
          logPrefix,
          partIndex,
          partCount,
          canCallLlm: callsUsed < CHUNK_SPLIT_CALL_BUDGET,
        });
        callsUsed += shrink.calls;
        if (shrink.refused) refusedFoldParts.push(partIndex);
        if (shrink.elidedChars > 0) {
          elidedFoldParts.push({ part: partIndex, elided: shrink.elidedChars });
        }
        running = shrink.text;
        pending.unshift(chunk);
        continue;
      }
      // Nothing left to split or shrink: accept the partial generation. The
      // text is the merged summary as far as the generation got - honest,
      // bounded, and strictly better than aborting the cycle (a cancel leaves
      // the session unable to compact at all). Overwriting the fold with text
      // shorter than the fold's own length would erase a summary that already
      // landed (the cut happened before the fold was reproduced), so keep the
      // fold in that case and record the part as unmerged.
      if (units.length < 2) {
        if (foldChars > 0 && text.length < foldChars) {
          log.warn(
            `[context-manager] ${logPrefix} chunk ${partIndex}/${partCount} hit its own token cap ` +
              `and its partial merge (${text.length} chars) is shorter than the running fold ` +
              `(${foldChars} chars) - keeping the fold, recording the part as unmerged`,
          );
          unmergedParts.push(partIndex);
          completed++;
          continue;
        }
        log.warn(
          `[context-manager] ${logPrefix} chunk ${partIndex}/${partCount} hit its own token cap ` +
            `(stopReason length) with nothing left to split - accepting the partial merge ` +
            `(${text.length} chars)`,
        );
        running = text;
        completed++;
        continue;
      }
      // Units are message arrays; the chunk carries a flat message list (as
      // planChunks does), so the halves are flattened before re-entry.
      const halfA = units.slice(0, Math.ceil(units.length / 2)).flat() as unknown[];
      const halfB = units.slice(Math.ceil(units.length / 2)).flat() as unknown[];
      log.warn(
        `[context-manager] ${logPrefix} chunk ${partIndex}/${partCount} hit its own token cap ` +
          `(stopReason length); splitting ${units.length} units into ${halfA.length}+${halfB.length} and retrying ` +
          `(${callsUsed}/${CHUNK_SPLIT_CALL_BUDGET} calls used)`,
      );
      pending.unshift(
        { messages: halfA, estimatedTokens: estimateMessagesTokens(halfA) },
        { messages: halfB, estimatedTokens: estimateMessagesTokens(halfB) },
      );
      continue;
    }
    if (result.usage) {
      usageSeen = true;
      usage.input += result.usage.input ?? 0;
      usage.output += result.usage.output ?? 0;
      usage.totalTokens += result.usage.totalTokens ?? 0;
    }
    running = text;
    completed++;
    if (pending.length > 0) notifyCompactionProgress(ctx);
  }

  log.info(
    `[context-manager] ${logPrefix} done: ${callsUsed} call(s) ` +
      `(planned ${chunks.length}, split retries ${callsUsed - completed}), ` +
      `span ${spanMessages} msgs / ~${spanTokens} tokens est -> summary ${(running ?? "").length} chars`,
  );
  const finalSummary = running ?? "";
  const notes: string[] = [];
  if (unmergedParts.length > 0) {
    notes.push(
      `part(s) ${unmergedParts.join(", ")} of this span were not merged - their summarization ` +
        "generations were cut before they reproduced the running summary. The full span stays in " +
        "the append-only session file.",
    );
  }
  if (refusedFoldParts.length > 0) {
    notes.push(
      `the running fold could not be compressed at part(s) ${refusedFoldParts.join(", ")} - the ` +
        "rewrite was length-stopped or below the keep floor, so the fold was reduced " +
        "deterministically instead.",
    );
  }
  if (elidedFoldParts.length > 0) {
    const totalElided = elidedFoldParts.reduce((sum, e) => sum + e.elided, 0);
    const parts = elidedFoldParts.map((e) => e.part).join(", ");
    notes.push(
      `the running summary was elided deterministically at part(s) ${parts}: ${totalElided} ` +
        "characters from the middle were dropped (head and tail kept) to bring the fold below " +
        "its budget. The elided text stays in the append-only session file.",
    );
  }
  return {
    summary: notes.length > 0 ? `${finalSummary}\n\n[note: ${notes.join(" ")}]` : finalSummary,
    chunkCount: chunks.length,
    spanMessages,
    spanTokens,
    usage: usageSeen ? usage : undefined,
  };
}

/**
 * Serialize one chunk's messages for the summarizer, with the same
 * truncation discipline pi-core applies to compaction input: toolResult
 * content is cut at 2000 chars, then the whole block is JSON-embedded in the
 * prompt so structural roles survive the text-only call.
 */
function serializeSpanForChunk(messages: readonly unknown[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const m = message as {
      role?: string;
      content?: unknown;
      toolName?: string;
      toolCallId?: string;
    };
    const role = m?.role ?? "unknown";
    let text = "";
    if (typeof m?.content === "string") {
      text = m.content;
    } else if (Array.isArray(m?.content)) {
      text = (
        m.content as Array<{
          type?: string;
          text?: string;
          name?: string;
          arguments?: unknown;
          output?: unknown;
        }>
      )
        .map((c) => {
          if (c?.type === "text" && typeof c.text === "string") return c.text;
          if (c?.type === "toolCall")
            return `[tool call: ${c.name ?? "?"} ${JSON.stringify(c.arguments ?? {}).slice(0, 400)}]`;
          if (c?.type === "image") return "[image]";
          return `[${c?.type ?? "block"}]`;
        })
        .join("\n");
    }
    if (role === "toolResult") {
      text = `[tool result: ${m.toolName ?? "?"}] ${text}`;
    }
    if (text.length > 2000) text = `${text.slice(0, 2000)}…[truncated]`;
    lines.push(`${role}: ${text}`);
  }
  return lines.join("\n");
}
