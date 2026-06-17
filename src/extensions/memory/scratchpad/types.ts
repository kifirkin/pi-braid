/**
 * Scratchpad Types - session memory model (CCA L2)
 *
 * All type definitions used by scratchpad and imported by other modules.
 * Split from scratchpad/index.ts for maintainability.
 */

/** Session phase - the agent's current mode of operation */
export type SessionPhase =
  | "idle"
  | "exploring"
  | "planning"
  | "implementing"
  | "verifying"
  | "debugging"
  | "documenting";

/** Agent operational mode */
export type AgentMode = "normal" | "deep_think" | "recovery";

/** Structured session metadata */
export interface SessionMeta {
  /** Current turn number (updated by enforcement or manually) */
  turn: number;
  /** Current phase of work */
  phase: SessionPhase;
  /** Operational mode */
  mode: AgentMode;
  /** Last turn context was compacted */
  last_compact_turn: number;
  /** Session start time (epoch ms) */
  session_start: number;
  /** Last time any field was updated */
  updated_at: number;
}

/** An active constraint - enforcement rule, blocker, or invariant */
export interface Constraint {
  id: string;
  type: "blocker" | "enforcement_rule" | "invariant" | "custom";
  /** Human-readable description */
  description: string;
  /** When added (epoch ms) */
  added_at: number;
  /** When it should be re-evaluated (epoch ms, 0 = no expiry) */
  expires_at: number;
  /** Whether it has been acknowledged by the agent */
  acknowledged: boolean;
}

/** A key learning - root cause, pattern, fix discovered during session */
export interface KeyLearning {
  id: string;
  /** Concise statement of the learning */
  content: string;
  /** Category for organization */
  category: "root_cause" | "pattern" | "fix" | "constraint" | "codebase_fact";
  /** What file(s) or area this relates to */
  scope: string[];
  /** When added (epoch ms) */
  added_at: number;
  /** Whether this has been persisted to memory_store */
  persisted: boolean;
}

/** A single plan step with optional budget metadata (BAVT) */
export interface PlanStep {
  /** Stable ID for targeted removal. Generated at add time. */
  id: string;
  text: string;
  estimateCalls?: number;
  budgetCalls?: number;
  spentCalls: number;
  startTurn: number;
  doneTurn: number;
  startTotalCalls: number;
}

/** A decision with reasoning context */
export interface Decision {
  /** Stable ID for targeted removal. */
  id: string;
  text: string;
  reason?: string;
  turn: number;
}

/** A note in the scratchpad */
export interface NoteItem {
  /** Stable ID for targeted removal. */
  id: string;
  text: string;
  turn: number;
  addedAt: number;
}

/** A hypothesis in the scratchpad */
export interface HypothesisItem {
  /** Stable ID for targeted removal. */
  id: string;
  text: string;
  turn: number;
  addedAt: number;
}

/** A completed plan step (archived here for history) */
export interface DoneItem {
  /** Stable ID for targeted removal. */
  id: string;
  text: string;
  turn: number;
  addedAt: number;
}

// TaskItem and TaskStore were used by the now-removed 'task' tool (task.ts).
// The scratchpad's PlanStep[] (with add_plan / mark_done actions) covers
// the same use case without a separate type tree.

/** Main scratchpad type */
export interface TaskScratchpad {
  /** Original goal/task */
  goal: string;
  /** Goal from previous session (survives set_goal) */
  prior_goal: string;
  /** Steps to complete */
  plan: PlanStep[];
  /** Steps completed */
  done: DoneItem[];
  /** Key decisions made */
  decisions: Decision[];
  /** Multiple hypotheses (for debugging) */
  hypotheses: HypothesisItem[];
  /** Notes/thoughts */
  notes: NoteItem[];

  // ── CCA L2: Structured Session Memory ───────────────────────────────

  /** Session metadata */
  session: SessionMeta;
  /** Active constraints */
  constraints: Constraint[];
  /** Key learnings discovered this session */
  key_learnings: KeyLearning[];

  // ── Persistence ───────────────────────────────────────────────────────

  /** Timestamp of last mutation */
  updatedAt: number;
  /** Project slug this scratchpad belongs to */
  projectSlug: string;
}
