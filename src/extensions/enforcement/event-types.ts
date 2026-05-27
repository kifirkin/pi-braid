/**
 * Enforcement Event Types — strongly typed interfaces for pi event shapes.
 *
 * Created during Phase 3 God Object split to eliminate `any` parameters
 * in handler-registry.ts and its extracted sub-handlers.
 */

import type { NudgeManager } from "./nudge-manager.js";

// ── Event Types ────────────────────────────────────────────────────────────

export interface ToolCallEvent {
  toolName?: string;
  input?: Record<string, unknown>;
  source?: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  name: string;
  input: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type MessageContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface MessageEndEvent {
  message: {
    role: "user" | "assistant" | "system";
    content: MessageContentBlock[];
    stopReason?: string;
    errorMessage?: string;
  };
  messages?: Array<{ role: string; content?: unknown }>;
}

export interface SessionStartEvent {
  task?: string;
  prompt?: string;
  messages?: Array<{ role: string; content?: unknown }>;
}

export interface ToolResultEvent {
  toolName?: string;
  error?: string;
  isError?: boolean;
}

export interface SessionCompactEvent {
  compactionEntry?: { id?: string; summary?: string };
  result?: unknown;
}

export interface AutoRetryEndEvent {
  success: boolean;
  attempt: number;
  finalError?: string;
}

export interface SessionShutdownEvent {
  outcome?: string;
  error?: unknown;
}

export interface TurnEndEvent {
  message?: {
    role: string;
    content?: MessageContentBlock[];
  };
}

// ── Handler Registration Types ─────────────────────────────────────────────

export interface HandlerRegistration {
  event: string;
  method: "pi.on" | "onEvent" | "registerSessionStartHandler" | "registerTurnEndHandler";
  handler: string;
}

// ── Context Shape ──────────────────────────────────────────────────────────

export interface EnforcementContext {
  sessionManager: {
    getBranch(): Array<{
      id: string;
      type?: string;
      message?: { role?: string; content?: unknown };
    }>;
    getLeafId(): string | null;
    getLabel?(id: string): string | undefined;
    appendLabelChange?(targetId: string, label: string): void;
  };
  cwd?: string;
  getContextUsage?: () => { percent: number; tokens: number; contextWindow: number };
  whisper?: (msg: string, opts?: { category?: string; priority?: string }) => void;
  ui?: {
    notify: (msg: string, type: string) => void;
    setStatus: (key: string, value: string | undefined) => void;
  };
  abort?: () => void;
  compact?: (options?: { customInstructions?: string }) => void;
}

// ── Common handler signature ───────────────────────────────────────────────

export type EventHandler<T = any> = (
  event: T,
  ctx: EnforcementContext,
) => void | Promise<void | { block?: boolean; reason?: string } | undefined>;

export type RegisterHandlerFn = (
  pi: { on?: (event: string, handler: EventHandler) => void; registerTool?: (opts: any) => void },
  nudgeManager?: NudgeManager,
) => void;
