/**
 * @fileoverview Extension context type augmentations for pi-braid.
 *
 * Centralizes knowledge of @earendil-works/pi-coding-agent's ExtensionContext
 * structure - what is directly accessible vs. what must be obtained via ctx.
 */

import type { ExtensionContext as BaseExtensionContext } from "@earendil-works/pi-coding-agent";

// Extended with pi-braid's own session state helpers
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionContext {
    /** Whisper a low-priority hint without blocking execution */
    whisper?(message: string, opts?: WhisperOptions): void;
    /** Send enforcement signal for compliance verification */
    enforcer?: {
      sendEnforcementWhisper?(message: string): void;
      verifyCompliance?(response: string): Promise<EnforcementSignal[]>;
    };
    /** Analytics for tracking metrics, tool calls, session data */
    analytics?: {
      recordToolCall?(
        toolName: string,
        timestamp: number,
        metadata?: Record<string, unknown>,
      ): void;
      recordSignal?(signal: EnforcementSignal): void;
      recordDegradation?(event: DegradationEvent): void;
    };
  }
}

/**
 * The agent's ExtensionContext object exposes these fields:
 *
 * - model: the currently active Model<Api>
 * - modelRegistry: provider registry (find(provider, modelId), getAvailable(), getAll())
 * - settingsManager: user settings (getDefaultProvider(), getDefaultModel(), etc.)
 * - toolRegistry: registered tools
 *
 * Tool execute functions DO NOT receive ctx directly - they only get:
 *   (toolCallId, params, signal, onUpdate, _ctx)
 * where _ctx is undefined for extension tools (only builtin tools get it).
 *
 * So extension tools should NOT rely on _ctx for model resolution.
 * Instead:
 *   - Listen to "model_select" events and cache the model
 *   - Or use pi.model if the ExtensionApi exposes it
 */
export type { BaseExtensionContext as ExtensionContext };

/**
 * Type for the `pi` object (ExtensionApi) used in extensions.
 * Note: this is NOT the same as ExtensionContext.
 */
export interface ExtensionApi {
  registerTool(name: string, definition: unknown): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  model?: unknown;
  modelRegistry?: unknown;
}

// ── Supporting types ────────────────────────────────────────────────────────

interface WhisperOptions {
  category?: "enforcement" | "quality" | "safety" | "cognitive";
  priority?: "low" | "medium" | "high";
}

interface EnforcementSignal {
  type: "compliance" | "deception" | "incomplete" | "hallucination" | "scope_violation";
  severity: number;
  confidence: number;
  evidence: string;
  remediation: string;
  nudgeType: "whisper" | "warn" | "block";
  category: "enforcement" | "quality" | "safety";
}

interface DegradationEvent {
  timestamp: number;
  reason: string;
  severity: number;
  action?: string;
}
