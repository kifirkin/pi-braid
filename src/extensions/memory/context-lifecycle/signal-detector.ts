/**
 * Signal Detector - Pure function for analyzing session content context signals.
 *
 * Transformed from class-based SignalDetector to a pure function +
 * externally-managed state object (no class instance, no methods).
 */

import { createLogger } from "../../../lib/core/logger.js";
import type { SemanticSignal, SemanticSignalType } from "./types.js";
import { createSignal } from "./types.js";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import { hashForDedup } from "../../../lib/utils/dedup.js";

const VALID_TOPICS = new Set([
  "implementation",
  "debugging",
  "refactoring",
  "testing",
  "exploration",
  "documentation",
  "planning",
  "verification",
  "general",
]);

const log = createLogger("context-lifecycle");

// ── Content Analysis ────────────────────────────────────────────────────────

function extractTextContent(entry: SessionEntry): string {
  if (entry.type !== "message") return "";
  const msg = (
    entry as {
      message?: { content?: string | Array<{ type?: string; text?: string; name?: string }> };
    }
  ).message;
  if (!msg?.content) return "";
  const content = msg.content;

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "object" && p !== null) {
          if (p.type === "text") return p.text ?? "";
          if (p.type === "toolCall") return `[tool: ${p.name}]`;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function hashContent(text: string): string {
  return hashForDedup(text);
}

// ── Topic Detection ─────────────────────────────────────────────────────────

/**
 * Classify the current work topic via CRITICS.topicClassification.
 * Replaces the previous hardcoded TOPIC_KEYWORDS map (8 topics × 5-8
 * keywords each) which produced too many false negatives - phrases
 * like "investigate why the parser fails" matched nothing, and
 * "investigate" appeared in both exploration and debugging lists
 * arbitrarily. The LLM handles semantic understanding correctly.
 *
 * On degradation, returns "general" (conservative default).
 */
async function detectTopic(text: string, ctx: ExtensionContext): Promise<string> {
  if (!text || text.length < 5) return "general";
  try {
    const result = await classify(
      ctx,
      CRITICS.topicClassification.criteria,
      { text: text.slice(0, 1500) },
      { timeoutMs: 60_000, fallback: () => "general" },
    );
    const label = result.label.trim().toLowerCase();
    return VALID_TOPICS.has(label) ? label : "general";
  } catch (err) {
    log.debug(`detectTopic failed: ${err}`);
    return "general";
  }
}

// ── Signal Detector State ───────────────────────────────────────────────────

export interface DetectorState {
  lastTopic: string;
  lastTopicTurn: number;
  topicHistory: Array<{ topic: string; turn: number }>;
  recentHashes: Map<string, number>;
  toolSequence: string[];
  lastTurn: number;
  pendingSignals: SemanticSignal[];
  contextUsage: number;
  entryCount: number;
}

export function createDetectorState(): DetectorState {
  return {
    lastTopic: "",
    lastTopicTurn: 0,
    topicHistory: [],
    recentHashes: new Map(),
    toolSequence: [],
    lastTurn: 0,
    pendingSignals: [],
    contextUsage: 0,
    entryCount: 0,
  };
}

// ── Pure Signal Detection ───────────────────────────────────────────────────

export async function detectSignals(
  state: DetectorState,
  entries: SessionEntry[],
  ctx: ExtensionContext,
  contextUsage = 0,
): Promise<SemanticSignal[]> {
  const signals: SemanticSignal[] = [];
  const newEntryCount = entries.length;

  // Session navigation detection
  if (state.entryCount > 0 && newEntryCount < state.entryCount - 2) {
    log.warn(
      `Session navigation detected: ${state.entryCount} → ${newEntryCount} entries, resetting`,
    );
    resetDetectorState(state);
  }

  if (newEntryCount <= state.entryCount) {
    state.contextUsage = contextUsage;
    state.entryCount = newEntryCount;
    signals.push(...state.pendingSignals);
    state.pendingSignals = [];
    return signals;
  }

  const newEntries = entries.slice(state.entryCount);
  state.entryCount = newEntryCount;
  state.contextUsage = contextUsage;

  state.lastTurn++;
  const turn = state.lastTurn;
  const allText: string[] = [];
  const hashes: string[] = [];
  const toolCalls: string[] = [];

  for (const entry of newEntries) {
    const text = extractTextContent(entry);
    if (text) {
      allText.push(text);
      hashes.push(hashContent(text));
    }

    if (entry.type === "message") {
      const msg = (
        entry as {
          message?: {
            role?: string;
            toolName?: string;
            content?: Array<{ type?: string; name?: string }>;
          };
        }
      ).message;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "toolCall" && block?.name) {
            toolCalls.push(block.name);
            state.toolSequence.push(block.name);
          }
        }
      }
      if (msg?.role === "toolResult" && msg?.toolName) {
        toolCalls.push(msg.toolName);
        state.toolSequence.push(msg.toolName);
      }
    }
  }

  // Redundancy detection
  let redundancyCount = 0;
  for (const h of hashes) {
    if (state.recentHashes.has(h)) {
      redundancyCount++;
    } else {
      if (state.recentHashes.size >= 100) {
        const oldest = Array.from(state.recentHashes.entries())
          .sort((a, b) => a[1] - b[1])
          .slice(0, 10);
        for (const [k] of oldest) state.recentHashes.delete(k);
      }
      state.recentHashes.set(h, turn);
    }
  }
  if (redundancyCount >= 2) {
    signals.push(createSignal("redundancy_detected", turn, { count: redundancyCount }));
  }

  // Topic shift detection (async - LLM topic classification)
  const combinedText = allText.join(" ");
  const currentTopic = await detectTopic(combinedText, ctx);
  if (currentTopic !== state.lastTopic && state.lastTopic !== "") {
    signals.push(createSignal("topic_shift", turn, { from: state.lastTopic, to: currentTopic }));
    state.topicHistory.push({ topic: currentTopic, turn });
    if (state.topicHistory.length > 20) state.topicHistory = state.topicHistory.slice(-20);
  }
  state.lastTopic = currentTopic;

  // Context pressure
  if (contextUsage >= 85) {
    signals.push(createSignal("context_pressure", turn, { percent: contextUsage }));
  } else if (contextUsage >= 70) {
    signals.push(createSignal("context_pressure", turn, { percent: contextUsage }));
  }

  // Task boundary detection
  if (state.toolSequence.length >= 3) {
    const last3 = state.toolSequence.slice(-3);
    const hasExplore = ["grep", "read", "bash", "find", "analyze_image"].some((t) =>
      last3.includes(t),
    );
    const hasImplement = ["write", "edit"].some((t) => last3.includes(t));
    const hasVerify = ["bash", "test", "verify"].some((t) => last3.includes(t));

    if (hasExplore && hasImplement && hasVerify) {
      signals.push(createSignal("task_boundary", turn, { pattern: last3 }));
    }
  }

  // Task complexity
  const uniqueToolTypes = new Set(toolCalls).size;
  const totalToolsThisTurn = toolCalls.length;
  if (uniqueToolTypes >= 4 || totalToolsThisTurn >= 5) {
    signals.push(
      createSignal("task_complexity", turn, {
        unique_tools: uniqueToolTypes,
        total_tools: totalToolsThisTurn,
      }),
    );
  }

  // Decision density
  const highStakesActions = toolCalls.filter((t) =>
    ["edit", "write", "finalize"].includes(t),
  ).length;
  const stateChanges = toolCalls.filter((t) =>
    ["memory_store", "context_tag", "context_checkout", "context_archive"].includes(t),
  ).length;
  if (highStakesActions >= 2 || (highStakesActions >= 1 && stateChanges >= 1)) {
    signals.push(
      createSignal("decision_density", turn, {
        high_stakes: highStakesActions,
        state_changes: stateChanges,
      }),
    );
  }

  // Flush pending
  signals.push(...state.pendingSignals);
  state.pendingSignals = [];

  return signals;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function queueSignal(
  state: DetectorState,
  type: SemanticSignalType,
  data: Record<string, unknown> = {},
): void {
  state.pendingSignals.push(createSignal(type, state.lastTurn, data));
}

export function resetDetectorState(state: DetectorState): void {
  state.lastTopic = "";
  state.lastTopicTurn = 0;
  state.topicHistory = [];
  state.recentHashes.clear();
  state.toolSequence = [];
  state.lastTurn = 0;
  state.pendingSignals = [];
  state.contextUsage = 0;
  state.entryCount = 0;
}

export function detectCompletionPattern(state: DetectorState): boolean {
  const hasTaskBoundary = state.topicHistory.length >= 2;
  const lowRedundancy = state.recentHashes.size > 5;
  const hasVerification = state.toolSequence.some((t) =>
    ["bash", "test", "verify", "repl"].includes(t),
  );
  const uniqueTools = new Set(state.toolSequence.slice(-10)).size;
  const diverseTools = uniqueTools >= 4;
  return hasTaskBoundary && lowRedundancy && hasVerification && diverseTools;
}
