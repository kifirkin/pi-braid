/**
 * Pre-send budget: compare the request about to be sent against the model's
 * resolved window, and refuse instead of letting the provider refuse.
 *
 * Why here: this is a request-layer decision. It needs three things at once -
 * the outgoing payload, the requested output budget, and the resolved window -
 * and only the layer that BUILDS the request has all three. A consumer that
 * reads a percentage sees a number someone else measured; it cannot see what
 * the provider is about to be handed.
 *
 * Why a guard and not a warning: a request over the window cannot succeed, so
 * sending it buys nothing and costs a full round trip, a retry, and a session
 * that looks wedged to whoever is watching. The remedy that actually frees
 * space is compaction, and the caller owns it - so the guard runs it once and
 * re-measures, and only then decides.
 */

import { formatTokensK } from "../detection/context-usage.js";

export interface SendBudgetInput {
  /** Calibrated tokens of the payload as it stands now. */
  payloadTokens: number;
  /** The output budget the request asks for; it is spent from the same window. */
  outputTokens: number;
  /** Resolved window (a configured cap may already bind below the model's). */
  contextWindow: number;
}

export interface SendBudgetVerdict {
  fits: boolean;
  /** payloadTokens + outputTokens. */
  projectedTokens: number;
  contextWindow: number;
  /** Tokens past the window; 0 when the request fits. */
  overBy: number;
}

export function checkSendBudget(input: SendBudgetInput): SendBudgetVerdict {
  const projectedTokens = input.payloadTokens + Math.max(0, input.outputTokens);
  const contextWindow = input.contextWindow;
  const overBy = contextWindow > 0 ? Math.max(0, projectedTokens - contextWindow) : 0;
  return {
    fits: contextWindow > 0 && overBy === 0,
    projectedTokens,
    contextWindow,
    overBy,
  };
}

/**
 * The one line a refusal is allowed to say. It carries the three numbers a
 * reader needs to act (payload, output budget, window) and names the remedy,
 * because "context overflow" alone leaves nothing to do.
 */
export function formatSendBudgetRefusal(verdict: SendBudgetVerdict, subject = "request"): string {
  const window =
    verdict.contextWindow > 0 ? formatTokensK(verdict.contextWindow) : "unknown window";
  return (
    `Context budget refused: ${subject} needs ${formatTokensK(verdict.projectedTokens)} ` +
    `(payload + output budget) against a ${window} window, over by ${formatTokensK(verdict.overBy)}. ` +
    `Nothing was sent. Compact first (\`context_compress action="archive"\`), or lower the output ` +
    `budget, then retry.`
  );
}

export type GuardedSend =
  | { allowed: true; verdict: SendBudgetVerdict; compacted: boolean }
  | { allowed: false; verdict: SendBudgetVerdict; line: string; compacted: boolean };

/**
 * Decide whether the send may proceed: measure, compare, and when the request
 * cannot fit, run the caller's compaction ONCE and measure again.
 *
 * `compact` returns true only when it actually freed context. A compaction
 * that frees nothing must not re-open the door - the second measurement is the
 * one that decides, and it is taken after the compaction, not assumed from it.
 * `measure` is called fresh each time for the same reason: the payload after a
 * compaction is a different payload.
 */
export async function guardAgainstDoomedSend(params: {
  measure: () => number;
  outputTokens: number;
  contextWindow: number;
  compact?: () => Promise<boolean> | boolean;
  onRefusal?: (line: string, verdict: SendBudgetVerdict) => void;
  subject?: string;
}): Promise<GuardedSend> {
  const window = params.contextWindow;
  let verdict = checkSendBudget({
    payloadTokens: params.measure(),
    outputTokens: params.outputTokens,
    contextWindow: window,
  });
  if (verdict.fits) return { allowed: true, verdict, compacted: false };

  let compacted = false;
  if (params.compact) {
    try {
      compacted = (await params.compact()) === true;
    } catch {
      // A failed compaction leaves the request where it was: still over.
      compacted = false;
    }
  }
  if (compacted) {
    verdict = checkSendBudget({
      payloadTokens: params.measure(),
      outputTokens: params.outputTokens,
      contextWindow: window,
    });
    if (verdict.fits) return { allowed: true, verdict, compacted: true };
  }

  const line = formatSendBudgetRefusal(verdict, params.subject);
  params.onRefusal?.(line, verdict);
  return { allowed: false, verdict, line, compacted };
}
