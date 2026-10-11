/**
 * Judge Budget - one implementation of the output-budget contract every
 * consolidated judge shares.
 *
 * A consolidated judge asks the model for a few booleans as JSON. Thinking
 * tokens count against max_tokens on every reasoning model braid routes to,
 * and the channel cannot be switched off for a model whose pi-ai
 * thinkingLevelMap declares no "off" level (clampThinkingLevel then maps "off"
 * up to the lowest level the model does declare). So a small explicit ceiling
 * is a ceiling on thinking, and the JSON body never gets written: the
 * completion stops at its own ceiling with nothing to parse.
 *
 * The invariant, in one place:
 *
 *   The first completion is issued with no maxTokens, so callLlm sizes a budget
 *   from the prompt (1000-4000) - the path judges that are not
 *   length-stop-prone already take. A completion that ends at its own output
 *   ceiling without yielding a verdict gets exactly one retry at
 *   min(ENLARGED_BUDGET_TOKENS, model.maxTokens).
 *
 * 8_192 is the budget lib/ai/text-classifier.ts settled on for the same failure
 * signature; the clamp to the model's own ceiling is there because a budget
 * above it is a client-side error, not a bigger answer. The retry is bounded by
 * construction: one per model, and the walk is bounded by its tier list (session,
 * utility), so the worst case is four completions per invocation.
 *
 * What this module deliberately does not know: what a verdict looks like, and
 * what a fall-through means. Each judge supplies its own reader (extractJson,
 * field validation, its own debug lines) and maps the returned outcome to its
 * own fall-through - null, heuristics, conservative defaults, or a counted
 * warning.
 *
 * No module-level mutable state: the mechanism counters live in the caller's
 * own stats holder, passed in as a sink.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { callLlm } from "./llm-call.js";
import { resolveUtilityModel } from "./model-resolver.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("judge-budget");

// ── Output budget ────────────────────────────────────────────────────────────

/**
 * Budget for the one-shot retry after a completion ends at its output ceiling
 * without yielding a verdict. Sizing rationale in the file header.
 */
export const ENLARGED_BUDGET_TOKENS = 8_192;

// ── Outcome vocabulary ───────────────────────────────────────────────────────

/** Why a judge completion produced no verdict. */
export type JudgeFailureReason =
  /** Ended at the output ceiling with nothing parseable, retry included. */
  | "budget-exhausted"
  /** Answered, but no JSON object was found in the response. */
  | "unparseable"
  /** Answered with JSON, but not the fields this judge needs. */
  | "invalid-fields"
  /** No API key, transport error, or a thrown call. */
  | "call-error";

/** One judge attempt: a verdict, or the reason there is none. */
export type JudgeOutcome<T> =
  | { ok: true; verdict: T; atCeiling: boolean }
  | { ok: false; reason: JudgeFailureReason; detail: string; atCeiling: boolean };

/**
 * The mechanism counters, for a caller that keeps a stats surface. A judge's
 * own stats object satisfies this structurally: the extra fields (invocations,
 * verdicts, fall-throughs) are the caller's business, these four are the
 * mechanism's.
 */
export interface JudgeBudgetCounters {
  /** Completions attempted (one per call, +1 when a retry fires). */
  modelCalls: number;
  /** Completions that ended at their output ceiling without a verdict. */
  budgetExhausted: number;
  /** Enlarged-budget retries issued. */
  retries: number;
  /** Retries that produced a verdict. */
  retryRecoveries: number;
}

// ── The judge's own reading of a completion ──────────────────────────────────

/** One completion as the judge's reader sees it. */
export interface JudgeCompletionView {
  /** The completion's text, trimmed. */
  text: string;
  /** The model ended at its own output ceiling (stopReason "length"). */
  atCeiling: boolean;
  /** The model that produced it. */
  model: Model<Api>;
  /** Milliseconds since the tier walk started. */
  elapsedMs: number;
}

/**
 * The judge's reading of one completion: a verdict, or why there is none.
 * `atCeiling` is handed to the reader so it can label the failure honestly
 * ("budget-exhausted" when the completion was cut off and nothing was
 * parseable, "unparseable"/"invalid-fields" when the answer itself was wrong).
 */
export type JudgeReading<T> =
  | { ok: true; verdict: T }
  | { ok: false; reason: JudgeFailureReason; detail: string };

export type JudgeReader<T> = (view: JudgeCompletionView) => JudgeReading<T>;

/** Everything a judge supplies: its prompts, its reader, its counters. */
export interface JudgeArgs<T> {
  ctx: ExtensionContext;
  systemPrompt: string;
  userMessage: string;
  read: JudgeReader<T>;
  /** Debug label, e.g. "consolidated-topic". */
  label: string;
  /** Where the mechanism counters accumulate; omit when the judge keeps none. */
  counters?: JudgeBudgetCounters;
  /** Per-completion timeout. Default 60_000 (the consolidated judges' own). */
  timeoutMs?: number;
}

// ── The walk ─────────────────────────────────────────────────────────────────

/**
 * Walk the model tiers a consolidated judge prefers - session, then utility -
 * each with the bounded budget retry. The last attempt's outcome is returned
 * when every tier fails, so the caller keeps the terminal reason and its
 * diagnostic.
 */
export async function judgeAcrossTiers<T>(args: JudgeArgs<T>): Promise<JudgeOutcome<T>> {
  const startedAt = Date.now();
  let last: JudgeOutcome<T> = {
    ok: false,
    reason: "call-error",
    detail: "no model was available to try",
    atCeiling: false,
  };

  const tiers = [args.ctx.model, resolveUtilityModel(args.ctx)];
  for (const model of tiers) {
    if (!model) continue;
    last = await judgeWithBudgetRetry(args, model, startedAt);
    if (last.ok) return last;
  }

  return last;
}

/**
 * The invariant: one completion, and - only when it ended at its own output
 * ceiling without yielding a verdict - exactly one retry at an enlarged budget.
 */
export async function judgeWithBudgetRetry<T>(
  args: JudgeArgs<T>,
  model: Model<Api>,
  startedAt: number,
): Promise<JudgeOutcome<T>> {
  const first = await judgeCompletion(args, model, startedAt);
  if (first.ok || !first.atCeiling) return first;

  // The completion was cut off by its own output ceiling. Since thinking
  // tokens count against max_tokens and the channel cannot be disabled for
  // every model braid routes to, the repair is room to finish: exactly one
  // retry, at an enlarged budget, and only for this signature.
  const retryMaxTokens = Math.min(
    ENLARGED_BUDGET_TOKENS,
    model.maxTokens ?? Number.POSITIVE_INFINITY,
  );
  if (args.counters) args.counters.retries++;
  log.debug(
    `[${args.label}] ${model.id} ${first.detail}; ` +
      `retrying once with maxTokens=${retryMaxTokens}`,
  );

  const retry = await judgeCompletion(args, model, startedAt, retryMaxTokens);
  if (retry.ok) {
    if (args.counters) args.counters.retryRecoveries++;
    return retry;
  }
  // Prefer the retry's reason either way: its diagnostic names the budget.
  return { ...retry, detail: `${retry.detail} (after retry at ${retryMaxTokens})` };
}

/**
 * One judge completion.
 *
 * No maxTokens on the first attempt: callLlm sizes a budget from the prompt
 * (1000-4000). The retry passes the enlarged budget explicitly.
 */
export async function judgeCompletion<T>(
  args: JudgeArgs<T>,
  model: Model<Api>,
  startedAt: number,
  maxTokens?: number,
): Promise<JudgeOutcome<T>> {
  let atCeiling = false;
  const failed = (reason: JudgeFailureReason, detail: string): JudgeOutcome<T> => {
    if (atCeiling && args.counters) args.counters.budgetExhausted++;
    return { ok: false, reason, detail, atCeiling };
  };

  try {
    const apiKey = await args.ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (!apiKey) {
      log.debug(`[${args.label}] No API key for ${model.provider}/${model.id}`);
      return failed("call-error", `no API key for ${model.provider}`);
    }

    if (args.counters) args.counters.modelCalls++;
    const result = await callLlm(model, apiKey, args.systemPrompt, args.userMessage, {
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      timeoutMs: args.timeoutMs ?? 60_000,
      ...(args.ctx.signal ? { signal: args.ctx.signal } : {}),
    });

    if ("error" in result) {
      log.debug(`[${args.label}] Model ${model.id} error: ${result.error}`);
      return failed("call-error", result.error);
    }

    const text = result.text.trim();
    // "length" is the model spending its whole output budget. Whether it left
    // partial text or none, the answer was cut off, and that is the one
    // failure a larger budget can fix.
    atCeiling = result.stopReason === "length";

    const reading = args.read({ text, atCeiling, model, elapsedMs: Date.now() - startedAt });
    if (!reading.ok) return failed(reading.reason, reading.detail);
    return { ok: true, verdict: reading.verdict, atCeiling };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    log.debug(`[${args.label}] Model ${model.id} failed ${elapsed}ms: ${err}`);
    return failed("call-error", `threw: ${err}`);
  }
}
