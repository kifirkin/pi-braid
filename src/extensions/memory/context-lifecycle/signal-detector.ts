/**
 * Signal Detector — Pure function for analyzing session content context signals.
 *
 * Transformed from class-based SignalDetector to a pure function +
 * externally-managed state object (no class instance, no methods).
 */

import { createLogger } from "../../../lib/logger.js";
import type { SemanticSignal, SemanticSignalType } from "./types.js";
import { createSignal } from "./types.js";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";

const log = createLogger("context-lifecycle");

// ── Content Analysis ────────────────────────────────────────────────────────

function extractTextContent(entry: SessionEntry): string {
  if (entry.type !== "message") return "";
  const msg = (
    entry as unknown as {
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
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ── Topic Detection ─────────────────────────────────────────────────────────

const TOPIC_KEYWORDS: Record<string, Set<string>> = {
  implementation: new Set(["implement", "write", "create", "add", "build", "code", "function"]),
  debugging: new Set(["bug", "fix", "error", "crash", "debug", "issue", "broken"]),
  refactoring: new Set(["refactor", "rename", "restructure", "clean", "improve"]),
  testing: new Set(["test", "spec", "verify", "assert", "coverage"]),
  exploration: new Set(["explore", "find", "search", "grep", "read", "discover"]),
  documentation: new Set(["doc", "comment", "readme", "explain", "describe"]),
  planning: new Set(["plan", "design", "architecture", "approach", "strategy"]),
  verification: new Set(["verify", "check", "validate", "confirm"]),
};

function detectTopic(text: string): string {
  const lower = text.toLowerCase();
  let bestTopic = "general";
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }

  return bestScore > 0 ? bestTopic : "general";
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

export function detectSignals(
  state: DetectorState,
  entries: SessionEntry[],
  contextUsage = 0,
): SemanticSignal[] {
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
        entry as unknown as {
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

  // Topic shift detection
  const combinedText = allText.join(" ");
  const currentTopic = detectTopic(combinedText);
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
