/**
 * Consolidated Topic Critic -- single LLM call for all 3 topic-drift checks.
 *
 * Replaces 3 parallel classify() calls (topicCoverage, topicDivergence,
 * topicCompleteness) with one structured-output LLM call that returns all
 * three verdicts as JSON. Falls back to conservative heuristic fallbacks
 * (topicDriftFallback -> "no" for all dimensions) on failure.
 *
 * Benefits:
 *   - 3x fewer LLM calls -> ~66% latency reduction at turn_end
 *   - Single system prompt shared across all three dimensions
 *   - Model can cross-reference dimensions (e.g., divergence vs coverage)
 *   - Same return interface -- drop-in replacement for both call sites
 *     (lib/detection/topic-drift-detector.ts and the extension handler)
 *
 * Output budget: the answer is ~40 tokens of JSON, but thinking tokens count
 * against max_tokens on every reasoning model braid routes to, and the channel
 * cannot be switched off for a model whose thinkingLevelMap declares no "off"
 * level (pi-ai clamps "off" to the lowest declared level). So a small explicit
 * ceiling is a ceiling on thinking and the JSON body never gets written. The
 * mechanism that answers this - first completion with no maxTokens, one
 * enlarged-budget retry when a completion ends at its ceiling without a
 * verdict - lives in lib/ai/judge-budget.ts and is shared with the other two
 * consolidated judges.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractJson } from "../../lib/utils/extract-json.js";
import { createLogger } from "../../lib/core/logger.js";
import {
  judgeAcrossTiers,
  type JudgeCompletionView,
  type JudgeReading,
} from "../../lib/ai/judge-budget.js";

const log = createLogger("consolidated-topic-critic");

// ── Consolidated Prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a topic-drift analyzer. You do one thing: " +
  "read an original request and an agent response inside XML tags, " +
  "and rate the response on three binary dimensions. " +
  "Respond with a valid JSON object containing exactly these three fields. " +
  "No explanation, no markdown, no other text.";

const USER_PROMPT =
  "Analyze the response against the original request. Respond with valid JSON only:\n" +
  "{\n" +
  '  "coversTopic": true|false,   // Does the response still address the original request? (true = yes, still relevant)\n' +
  '  "hasDiverged": true|false,   // Has the response shifted to a substantially different topic? (true = yes, drifted away)\n' +
  '  "isComplete": true|false     // Does the response cover all key topics from the request? (true = complete)\n' +
  "}\n\n" +
  "<original>\n{{original}}\n</original>\n\n" +
  "<response>\n{{response}}\n</response>";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConsolidatedTopicVerdict {
  /** true = still addresses the original request (coverage was "yes") */
  coversTopic: boolean;
  /** true = has shifted to a different topic (divergence was "yes") */
  hasDiverged: boolean;
  /** true = covers all key topics (completeness was "yes") */
  isComplete: boolean;
}

export interface ConsolidatedTopicResult {
  coverage: boolean;
  divergence: boolean;
  completeness: boolean;
  classifierDown: boolean;
}

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Consolidated topic critique -- single LLM call for all 3 drift dimensions.
 *
 * Model tier strategy (modelPreference: "quality"):
 *   1. Try session model (cheap, may already be powerful)
 *   2. If session fails, try utility model
 *   3. If both fail, try max-power model (accuracy-critical safety net)
 *   4. If all fail, use conservative defaults (no drift detected)
 */
export async function consolidatedTopicCritique(
  original: string,
  response: string,
  ctx: ExtensionContext,
): Promise<ConsolidatedTopicResult> {
  const truncatedOriginal = original.length > 2000 ? original.slice(0, 2000) + "..." : original;
  const truncatedResponse = response.length > 2000 ? response.slice(0, 2000) + "..." : response;
  const start = Date.now();

  // ── Attempt consolidated LLM call ──────────────────────────────────────
  const verdict = await tryConsolidatedCall(truncatedOriginal, truncatedResponse, ctx);

  if (verdict) {
    const latency = Date.now() - start;
    log.debug(`[consolidated-topic] OK ${latency}ms: ${JSON.stringify(verdict)}`);
    return {
      // coverage="no" -> bad (does NOT address request), so invert coversTopic
      coverage: verdict.coversTopic,
      divergence: verdict.hasDiverged,
      completeness: verdict.isComplete,
      classifierDown: false,
    };
  }

  // ── Fallback: conservative defaults (no drift) ─────────────────────────
  log.debug("[consolidated-topic] LLM failed, using conservative defaults");
  return {
    coverage: true,
    divergence: false,
    completeness: true,
    classifierDown: true,
  };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * The consolidated judge, across the model tiers, on the shared output-budget
 * contract (lib/ai/judge-budget.ts): session model first, then utility, then
 * max-power as safety net, each with at most one enlarged-budget retry.
 */
async function tryConsolidatedCall(
  original: string,
  response: string,
  ctx: ExtensionContext,
): Promise<ConsolidatedTopicVerdict | null> {
  const userMessage = USER_PROMPT.replace("{{original}}", original).replace(
    "{{response}}",
    response,
  );
  const outcome = await judgeAcrossTiers({
    ctx,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    read: readTopicVerdict,
    label: "consolidated-topic",
  });
  return outcome.ok ? outcome.verdict : null;
}

/**
 * Read one completion as a topic-drift verdict. The mapping from "what the
 * model said" to "why there is no verdict" is this judge's business; the retry
 * decision above it is not.
 */
function readTopicVerdict(view: JudgeCompletionView): JudgeReading<ConsolidatedTopicVerdict> {
  const jsonStr = extractJson(view.text);
  if (!jsonStr) {
    log.debug(
      `[consolidated-topic] No JSON found from ${view.model.id} ${view.elapsedMs}ms: ${view.text.slice(0, 100)}`,
    );
    return {
      ok: false,
      reason: view.atCeiling ? "budget-exhausted" : "unparseable",
      detail: `${view.text.length} chars of response, no JSON`,
    };
  }

  let parsed: ConsolidatedTopicVerdict;
  try {
    parsed = JSON.parse(jsonStr) as ConsolidatedTopicVerdict;
  } catch {
    log.debug(
      `[consolidated-topic] Unparseable JSON from ${view.model.id}: ${jsonStr.slice(0, 100)}`,
    );
    return {
      ok: false,
      reason: view.atCeiling ? "budget-exhausted" : "unparseable",
      detail: `enclosed object is not parseable JSON`,
    };
  }

  if (
    typeof parsed.coversTopic === "boolean" &&
    typeof parsed.hasDiverged === "boolean" &&
    typeof parsed.isComplete === "boolean"
  ) {
    return { ok: true, verdict: parsed };
  }

  log.debug(`[consolidated-topic] Invalid fields from ${view.model.id}: ${jsonStr}`);
  return { ok: false, reason: "invalid-fields", detail: `JSON without the three boolean fields` };
}
