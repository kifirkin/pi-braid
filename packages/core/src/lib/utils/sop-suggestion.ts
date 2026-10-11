/**
 * SOP Retrieval & Suggestion - Consolidation Channel Phase 2
 *
 * Queries three-memory-stores for relevant SOPs when a new task starts,
 * surfaces them via whisper (injected context) so the agent benefits
 * from past experiences without explicit retrieval commands.
 *
 * Flow:
 *   turn_start -> extract task keywords from user message
 *             -> query episodic memory for relevant episodes
 *             -> extract SOPs from matching episodes
 *             -> inject top SOPs as hint messages
 *
 * This implements the "suggestion" half of the consolidation pipeline:
 *   Phase 1: Extraction (sop-extractor.ts)
 *   Phase 2: Retrieval + Suggestion <- you are here
 *   Phase 3: Periodic consolidation (consolidation-channel.ts)
 */

import { createLogger } from "../core/logger.js";
import { sendTrackedMessage } from "../utils/injection-tracker.js";
import { fenceMemoryContext } from "../utils/memory-fence.js";
import { eventBus } from "../events/event-bus.js";
import { classify as textClassifier } from "../ai/text-classifier.js";
import { pushBounded } from "./bounded.js";
import { getExtensionState } from "../state/extension-state.js";
import { STOP_WORDS } from "../ai/critic-registry.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Episode } from "../types/episode-types.js";

const log = createLogger("sop-suggestion");

const MAX_SUGGESTIONS_PER_TURN = 1;
const MIN_SIMILARITY = 0.3;
const MAX_TOTAL_TOKENS = 800;
const TASK_EXCLUDE_PATTERNS = [/\/retry/, /^\[retry\]/];

export interface RetrievedSop {
  episode: Episode;
  similarity: number;
  strategicSOP: string | undefined;
  functionalSOPs: string[];
  matchedKeywords: string[];
}

interface SuggestionFeedback {
  episodeId: string;
  suggestedAt: number;
  followed: boolean;
  /** Which tools were called after suggestion was injected */
  subsequentTools: string[];
}

interface SopSuggestionState {
  suggestionFeedback: SuggestionFeedback[];
  lastSuggestionEpisodeId: string | null;
  lastSuggestionTurn: number;
}

function getSopState(ctx: ExtensionContext): SopSuggestionState {
  return getExtensionState(ctx, "sop-suggestion-feedback", () => ({
    suggestionFeedback: [],
    lastSuggestionEpisodeId: null,
    lastSuggestionTurn: 0,
  }));
}

export function trackSuggestionFeedback(ctx: ExtensionContext, toolName: string): void {
  const state = getSopState(ctx);
  if (!state.lastSuggestionEpisodeId) return;

  const fb = state.suggestionFeedback.find((f) => f.episodeId === state.lastSuggestionEpisodeId);
  if (fb) {
    // Per-tool-call growth inside the feedback entry; consumer only
    // pattern-matches recent tools. Cap 100, drop-oldest.
    pushBounded(fb.subsequentTools, toolName, 100);
    // Detect if agent followed the SOP pattern
    if (
      toolName === "grep" ||
      toolName === "find" ||
      toolName === "read" ||
      toolName === "write" ||
      toolName === "edit"
    ) {
      // Tool matches common SOP patterns - consider it followed
      fb.followed = true;
    }
  }
}

/**
 * Extract task keywords from user message text.
 * Uses fast heuristic extraction as primary path, with LLM classifier
 * enhancement for high-value keywords when available.
 *
 * The classifier extracts task-relevant phrases that stopword filtering
 * misses - e.g., "split the tools.ts into focused files" -> the classifier
 * catches "tools.ts" and "split into focused files" as keywords.
 */
async function classifyTaskKeywords(text: string, _ctx?: any): Promise<string[]> {
  if (!text || text.length < 5) return [];

  // Fast path: heuristic extraction (always works, no latency)
  const heuristicKeywords = extractKeywords(text);
  const projectKeywords = extractProjectKeywords(text);
  const baseKeywords = [...new Set([...projectKeywords, ...heuristicKeywords])];

  // Enhance with classifier if available (best-effort, non-blocking)
  let classifierKeywords: string[] = [];
  if (_ctx) {
    try {
      const result: any = await textClassifier(
        _ctx,
        {
          systemPrompt:
            "You are a task keyword extractor. Extract 3-5 key technical terms from the user's request. Return them as a comma-separated list. Focus on: file names, function names, concepts, and technologies.",
          userPrompt: `Extract keywords from: "${text.slice(0, 500)}"`,
        },
        {},
        { timeoutMs: 60_000 },
      );
      if (result.label) {
        classifierKeywords = result.label
          .split(",")
          .map((k: string) => k.trim().toLowerCase())
          .filter((k: string) => k.length > 2);
      }
    } catch {
      // Non-fatal - fall through to heuristic-only result
    }
  }

  return [...new Set([...baseKeywords, ...classifierKeywords])];
}

/**
 * Extract task keywords from user message text.
 * Uses the centralized STOP_WORDS list (replaces a 100-word
 * inline list that duplicated most of the centralized set plus a few
 * conversation openers). Returns meaningful identifiers.
 */
function extractKeywords(text: string): string[] {
  if (!text || text.length < 5) return [];

  const clean = text
    .replace(/^(hello|hi|hey|thanks|thank you|please|can you|could you|would you)/i, "")
    .replace(/(thanks|thank you|please|btw|by the way)$/i, "")
    .replace(/[^a-z0-9_-]+/gi, " ")
    .trim();

  if (!clean) return [];

  const words = clean
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const seen = new Set<string>();
  return words.filter((w) => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
}

/**
 * Extract project-specific keywords from a path string.
 * Returns directory names, filenames (without extension), framework names.
 */
function extractProjectKeywords(text: string): string[] {
  const keywords: string[] = [];

  const paths = text.match(/[a-zA-Z0-9_\-./]+\.[a-zA-Z]+/g) || [];
  for (const p of paths) {
    const parts = p.replace(/\\/g, "/").split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i].length > 2) keywords.push(parts[i]);
    }
    const name = parts[parts.length - 1].replace(/\.[^.]+$/, "");
    if (name.length > 2) keywords.push(name.toLowerCase());
  }

  const identifiers = text.match(/[a-z][a-zA-Z0-9]{2,}|[A-Z][a-z]{2,}[a-zA-Z0-9]*/g) || [];
  for (const id of identifiers) {
    if (id.length > 2) keywords.push(id.toLowerCase());
  }

  return [...new Set(keywords)];
}

/**
 * Compute Jaccard similarity between query keywords and episode task.
 * Matches reward increased for best-pattern matches when feedback exists.
 */
function computeSimilarity(
  ctx: ExtensionContext,
  queryKeywords: string[],
  episodeTask: string,
  episodeId?: string,
): number {
  if (queryKeywords.length === 0 || !episodeTask) return 0;

  const episodeWords = episodeTask
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const episodeSet = new Set(episodeWords);
  let matches = 0;

  for (const kw of queryKeywords) {
    if (episodeSet.has(kw)) {
      matches += 2;
      continue;
    }
    for (const ew of episodeWords) {
      if (ew.includes(kw) || kw.includes(ew)) {
        matches += 1;
        break;
      }
    }
  }

  // Feedback boost: the episode was suggested earlier and the agent followed it
  let union = queryKeywords.length + episodeSet.size;
  const sopState = ctx ? getSopState(ctx) : null;
  if (
    episodeId &&
    sopState?.suggestionFeedback.some((f) => f.episodeId === episodeId && f.followed)
  ) {
    union = Math.max(1, union - 1); // Slight boost to similarity
  }

  return union > 0 ? matches / union : 0;
}

export async function retrieveRelevantSOPs(
  ctx: ExtensionContext,
  userMessage: string,
  episodes: Episode[],
  currentProject?: string,
): Promise<RetrievedSop[]> {
  if (episodes.length === 0) return [];

  // Pre-filter by project to prevent memory contamination
  const now = Date.now();
  const filtered = currentProject
    ? episodes.filter((ep) => {
        if (!ep.project || ep.project === currentProject || ep.project === "unknown") return true;
        const ageMs = now - (ep.timestamp ?? 0);
        return ageMs < 3600000 && ep.outcome === "success";
      })
    : episodes;

  if (filtered.length === 0) return [];

  const keywords = await classifyTaskKeywords(userMessage);

  if (keywords.length === 0) return [];

  // Score episodes
  const scored: RetrievedSop[] = [];
  for (const ep of filtered) {
    const similarity = computeSimilarity(ctx, keywords, ep.task, ep.id);

    if (similarity < MIN_SIMILARITY) continue;

    scored.push({
      episode: ep,
      similarity,
      strategicSOP: ep.strategicSOP,
      functionalSOPs: ep.functionalSOP || [],
      matchedKeywords: keywords.slice(0, 5),
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, MAX_SUGGESTIONS_PER_TURN);
}

/**
 * Format a retrieved SOP as a whisper hint message.
 */
function formatSopSuggestion(retrieved: RetrievedSop, maxTokens: number): string {
  const ep = retrieved.episode;
  const lines: string[] = [];

  lines.push("## ⚡ Relevant past experience");
  lines.push(`**Task**: ${ep.task}`);
  lines.push(`**Outcome**: ${ep.outcome}`);
  if (ep.project && ep.project !== "unknown") {
    lines.push(`**Project**: ${ep.project}`);
  }
  lines.push(`**Similarity**: ${Math.round(ep.similarity * 100)}%`);

  if (retrieved.strategicSOP) {
    lines.push("");
    lines.push(`**Strategy**: ${retrieved.strategicSOP.slice(0, 200)}`);
  }

  if (retrieved.functionalSOPs.length > 0) {
    lines.push("");
    lines.push("**Approach**:");
    const steps = retrieved.functionalSOPs.slice(0, 3);
    for (const step of steps) {
      lines.push(`  ${step.slice(0, 100)}`);
    }
  }

  lines.push("");
  const pct = Math.round(retrieved.similarity * 100);
  lines.push(`_(matched ${pct}% similarity to current task)_`);

  const text = lines.join("\n");

  if (text.length > maxTokens * 4) {
    return text.slice(0, maxTokens * 4) + "\n... _(truncated)_";
  }
  return text;
}

/**
 * Inject SOP suggestions into the agent's context via whisper.
 */
export async function injectSopSuggestions(
  pi: any,
  ctx: ExtensionContext,
  userMessage: string,
  episodes: Episode[],
  alreadySuggestedIds?: Set<string>,
  currentProject?: string,
): Promise<number> {
  const retrieved = await retrieveRelevantSOPs(ctx, userMessage, episodes, currentProject);
  if (retrieved.length === 0) return 0;

  let totalTokens = 0;
  let injected = 0;

  for (const r of retrieved) {
    if (alreadySuggestedIds && r.episode.id && alreadySuggestedIds.has(r.episode.id)) continue;
    if (r.episode.task && TASK_EXCLUDE_PATTERNS.some((p) => p.test(r.episode.task))) continue;

    const formatted = formatSopSuggestion(r, MAX_TOTAL_TOKENS);
    // Recalled episode SOPs are fenced non-user context. Fencing
    // before the token estimate keeps the MAX_TOTAL_TOKENS budget truthful.
    const fenced = fenceMemoryContext(formatted);
    const estimatedTokens = fenced.length / 4;

    if (totalTokens + estimatedTokens > MAX_TOTAL_TOKENS) break;

    // Track for feedback (session-scoped)
    if (r.episode.id) {
      const fbState = getSopState(ctx);
      fbState.lastSuggestionEpisodeId = r.episode.id;
      fbState.lastSuggestionTurn = Date.now();
      if (!fbState.suggestionFeedback.find((f) => f.episodeId === r.episode.id)) {
        // One entry per suggested episode for the session; capped
        // ring (drop-oldest) — dedup/find target recent suggestions.
        pushBounded(
          fbState.suggestionFeedback,
          {
            episodeId: r.episode.id,
            suggestedAt: Date.now(),
            followed: false,
            subsequentTools: [],
          },
          100,
        );
      }
    }

    if (r.episode.id && alreadySuggestedIds) {
      // Dedup-only set; cap 100 (FIFO) keeps the dedup window long
      // past any realistic repeat-suggestion horizon.
      alreadySuggestedIds.delete(r.episode.id);
      alreadySuggestedIds.add(r.episode.id);
      while (alreadySuggestedIds.size > 100) {
        const oldestId = alreadySuggestedIds.values().next();
        if (oldestId.done) break;
        alreadySuggestedIds.delete(oldestId.value);
      }
    }

    totalTokens += estimatedTokens;
    injected++;

    try {
      eventBus.emit({
        type: "sop_suggestion",
        episodeId: r.episode.id ?? "unknown",
        similarity: r.similarity,
        message: formatted,
        timestamp: Date.now(),
      });
    } catch {
      // Non-fatal - event bus may not be available
    }

    try {
      sendTrackedMessage(
        pi,
        {
          customType: "sop-suggestion",
          content: [{ type: "text" as const, text: fenced }],
          display: true,
        },
        { delivery: "park", deliverAs: "steer" },
        // Source root was "memory", which made the
        // envelope/_braidSource say memory while the body is an SOP
        // suggestion (family sop-suggestion). Fix attribution so the
        // envelope family == body family.
        { type: "sop-suggestion", source: "sop-suggestion/inject" },
      );
      log.info(
        `Suggested SOP "${r.episode.task.slice(0, 50)}" ` +
          `(similarity: ${(r.similarity * 100).toFixed(0)}%, ` +
          `keywords: ${r.matchedKeywords.slice(0, 3).join(", ")})`,
      );
    } catch (err) {
      log.warn(`Failed to inject SOP suggestion: ${err}`);
    }
  }

  return injected;
}
