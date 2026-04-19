/**
 * Scratchpad Extension - Structured Session Memory (CCA L2)
 *
 * Per-loop persistent state for continuity of thought across turns.
 * Persists to disk per-project so it survives process restarts.
 *
 * Structured sections (CCA L2 - Agent Working Memory):
 * - Session metadata: current turn, phase, mode
 * - Active constraints: enforcement blockers and rules
 * - Key learnings: root causes, patterns, fixes discovered this session
 * - Goal / Plan / Decisions / Hypotheses: existing sections
 *
 * Minimum-fidelity invariant: key_learnings survive context compaction.
 * When a compaction event is noted (note_compact), key learnings are
 * written to memory_store so they persist even if scratchpad resets.
 *
 * Storage: ~/.pi/agent/scratchpads/{project-slug}/latest.json
 * Tasks:  ~/.pi/agent/scratchpads/{project-slug}/tasks.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentToolResult, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────────────────────

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

/** Main scratchpad type */
export interface TaskScratchpad {
	/** Original goal/task */
	goal: string;
	/** Steps to complete */
	plan: string[];
	/** Steps completed */
	done: string[];
	/** Key decisions made */
	decisions: string[];
	/** Multiple hypotheses (for debugging) */
	hypotheses: string[];
	/** Notes/thoughts */
	notes: string[];

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

// ── Task Management ──────────────────────────────────────────────────────────

export interface TaskItem {
	id: string;
	description: string;
	status: "pending" | "running" | "completed" | "failed";
	priority: number;
	dependencies: string[];
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	result?: string;
	error?: string;
	attempts: number;
	maxAttempts: number;
}

interface TaskStore {
	tasks: TaskItem[];
	updatedAt: number;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const SCRATCHPAD_BASE_DIR = path.join(os.homedir(), ".pi", "agent", "scratchpads");

function projectSlugFromCwd(cwd?: string): string {
	if (!cwd) return "default";
	const segments = cwd.split("/").filter(Boolean);
	return "--" + segments.join("-") + "--";
}

function scratchpadFilePath(projectSlug: string): string {
	return path.join(SCRATCHPAD_BASE_DIR, projectSlug, "latest.json");
}

function createScratchpad(goal: string, projectSlug: string): TaskScratchpad {
	return {
		goal,
		plan: [],
		done: [],
		decisions: [],
		hypotheses: [],
		notes: [],
		session: {
			turn: 0,
			phase: "idle",
			mode: "normal",
			last_compact_turn: 0,
			session_start: Date.now(),
			updated_at: Date.now(),
		},
		constraints: [],
		key_learnings: [],
		updatedAt: Date.now(),
		projectSlug,
	};
}

function saveScratchpadToDisk(scratchpad: TaskScratchpad): void {
	try {
		const filePath = scratchpadFilePath(scratchpad.projectSlug);
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(filePath, JSON.stringify(scratchpad, null, 2));
	} catch {
		// Silent fail - operates in memory if disk write fails
	}
}

function loadScratchpadFromDisk(projectSlug: string): TaskScratchpad | null {
	try {
		const filePath = scratchpadFilePath(projectSlug);
		if (fs.existsSync(filePath)) {
			const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			if (!data.updatedAt) data.updatedAt = Date.now();
			if (!data.projectSlug) data.projectSlug = projectSlug;
			// Backfill new L2 fields for scratchpads created before this update
			if (!data.session) {
				data.session = {
					turn: 0,
					phase: "idle",
					mode: "normal",
					last_compact_turn: 0,
					session_start: data.updatedAt,
					updated_at: data.updatedAt,
				};
			}
			if (!data.constraints) data.constraints = [];
			if (!data.key_learnings) data.key_learnings = [];
			return data as TaskScratchpad;
		}
	} catch {
		// Silent fail
	}
	return null;
}

function taskFilePath(projectSlug: string): string {
	return path.join(SCRATCHPAD_BASE_DIR, projectSlug, "tasks.json");
}

function saveTaskStore(slug: string, store: TaskStore): void {
	try {
		const filePath = taskFilePath(slug);
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		store.updatedAt = Date.now();
		fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
	} catch {
		// Silent fail
	}
}

function loadTaskStore(projectSlug: string): TaskStore {
	try {
		const filePath = taskFilePath(projectSlug);
		if (fs.existsSync(filePath)) {
			return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TaskStore;
		}
	} catch {
		// Silent fail
	}
	return { tasks: [], updatedAt: Date.now() };
}

function generateTaskId(): string {
	return "task-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2, 6);
}

function generateLearningId(): string {
	return "learn-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2, 6);
}

function generateConstraintId(): string {
	return "constraint-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2, 6);
}

// ── Display ──────────────────────────────────────────────────────────────────

export function formatScratchpad(pad: TaskScratchpad): string {
	const lines = [`Goal: ${pad.goal || "(none)"}`];

	if (pad.session.turn > 0) {
		lines.push(`Session: turn ${pad.session.turn} | ${pad.session.phase} | ${pad.session.mode}`);
	}

	if (pad.plan.length > 0) {
		lines.push("\nPlan:");
		for (let i = 0; i < pad.plan.length; i++) {
			const step = pad.plan[i];
			const status = pad.done.includes(step) ? "[done]" : "[ ]";
			lines.push(`  ${status} ${i + 1}. ${step}`);
		}
	}

	if (pad.decisions.length > 0) {
		lines.push("\nDecisions:");
		for (const d of pad.decisions) {
			lines.push(`  - ${d}`);
		}
	}

	if (pad.hypotheses.length > 0) {
		lines.push("\nHypotheses:");
		for (let i = 0; i < pad.hypotheses.length; i++) {
			lines.push(`  ${i + 1}. ${pad.hypotheses[i]}`);
		}
	}

	if (pad.constraints.length > 0) {
		lines.push("\nActive Constraints:");
		for (const c of pad.constraints) {
			const exp = c.expires_at > 0 ? ` (expires: ${new Date(c.expires_at).toISOString()})` : "";
			const ack = c.acknowledged ? "" : " [UNACKED]";
			lines.push(`  [${c.type}] ${c.description}${exp}${ack}`);
		}
	}

	if (pad.key_learnings.length > 0) {
		lines.push("\nKey Learnings:");
		for (const l of pad.key_learnings) {
			const scope = l.scope.length > 0 ? ` (${l.scope.join(", ")})` : "";
			const persist = l.persisted ? "" : " [not persisted]";
			lines.push(`  [${l.category}] ${l.content}${scope}${persist}`);
		}
	}

	if (pad.notes.length > 0) {
		lines.push("\nNotes:");
		for (const n of pad.notes) {
			lines.push(`  - ${n}`);
		}
	}

	if (pad.session.last_compact_turn > 0) {
		lines.push(`\nContext last compacted: turn ${pad.session.last_compact_turn}`);
	}

	return lines.join("\n");
}

/**
 * Compact machine-readable session summary for agent to read quickly.
 * Returns a structured representation the agent can parse and use.
 */
export function formatSessionSummary(pad: TaskScratchpad): {
	session: SessionMeta;
	goal: string;
	plan_progress: { total: number; done: number };
	constraints_active: number;
	key_learnings_count: number;
	unpersisted_learnings: string[];
	decisions_count: number;
} {
	return {
		session: pad.session,
		goal: pad.goal,
		plan_progress: { total: pad.plan.length, done: pad.done.length },
		constraints_active: pad.constraints.filter((c) => c.expires_at === 0 || c.expires_at > Date.now()).length,
		key_learnings_count: pad.key_learnings.length,
		unpersisted_learnings: pad.key_learnings
			.filter((l) => !l.persisted)
			.map((l) => l.content),
		decisions_count: pad.decisions.length,
	};
}

// ── Module State ─────────────────────────────────────────────────────────────

let _taskScratchpad: TaskScratchpad | null = null;
let _currentProjectSlug: string = "";
let _taskStore: TaskStore = { tasks: [], updatedAt: Date.now() };

function getOrCreateScratchpad(projectSlug: string): TaskScratchpad {
	if (_taskScratchpad && _currentProjectSlug === projectSlug) {
		return _taskScratchpad;
	}

	const loaded = loadScratchpadFromDisk(projectSlug);
	if (loaded) {
		_taskScratchpad = loaded;
	} else {
		_taskScratchpad = createScratchpad("", projectSlug);
	}
	_currentProjectSlug = projectSlug;
	return _taskScratchpad;
}

function mutateAndSave(scratchpad: TaskScratchpad): void {
	scratchpad.updatedAt = Date.now();
	scratchpad.session.updated_at = Date.now();
	saveScratchpadToDisk(scratchpad);
}

function resolveProjectSlug(cwd?: string): string {
	try {
		return projectSlugFromCwd(cwd ?? process.cwd());
	} catch {
		return "default";
	}
}

// ── Schema ───────────────────────────────────────────────────────────────────

const scratchpadSchema = Type.Object({
	action: StringEnum(
		["read", "set_goal", "add_plan", "mark_done", "add_decision", "add_hypothesis",
		 "add_note", "update_session", "add_constraint", "remove_constraint",
		 "add_learning", "persist_learnings", "note_compact",
		 "elevate_to_goal", "elevate_to_plan",
		 "task_add", "task_list", "task_complete", "task_fail",
		 "task_next", "task_remove", "task_stats", "task_clear"],
		{ description: "Action to perform on the scratchpad" },
	),
	text: Type.Optional(
		Type.String({
			description:
				"Text content for set_goal, add_plan, add_decision, add_hypothesis, add_note, " +
				"add_constraint, add_learning. For add_constraint: \"type|description\" (e.g. \"blocker|file not found\"). " +
				"For add_learning: \"category|content|scope\" (e.g. \"root_cause|memory leak in connection pool|src/db/\")",
		}),
	),
	successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Success criteria (for elevate_to_goal)" })),
	priority: Type.Optional(Type.Number({ description: "Priority 0-10 (for elevate_to_goal, task_add)" })),
	dependencies: Type.Optional(Type.Array(Type.String(), { description: "Dependencies (for elevate_to_goal, task_add)" })),
	task_id: Type.Optional(Type.String({ description: "Task ID (for task_complete, task_fail)" })),
	// CCA L2 specific
	constraint_id: Type.Optional(Type.String({ description: "Constraint ID (for remove_constraint)" })),
	expires_in_ms: Type.Optional(Type.Number({ description: "TTL in ms for constraint expiry (default: 0 = no expiry)" })),
	turn: Type.Optional(Type.Number({ description: "Current turn number (for update_session)" })),
	phase: Type.Optional(
		StringEnum(
			["idle", "exploring", "planning", "implementing", "verifying", "debugging", "documenting"],
			{ description: "Session phase (for update_session)" },
		),
	),
	mode: Type.Optional(
		StringEnum(
			["normal", "deep_think", "recovery"],
			{ description: "Agent mode (for update_session)" },
		),
	),
});

type ScratchpadToolInput = {
	action:
		| "read" | "set_goal" | "add_plan" | "mark_done" | "add_decision"
		| "add_hypothesis" | "add_note"
		| "update_session" | "add_constraint" | "remove_constraint"
		| "add_learning" | "persist_learnings" | "note_compact"
		| "elevate_to_goal" | "elevate_to_plan"
		| "task_add" | "task_list" | "task_complete" | "task_fail"
		| "task_next" | "task_remove" | "task_stats" | "task_clear";
	text?: string;
	successCriteria?: string[];
	priority?: number;
	dependencies?: string[];
	task_id?: string;
	constraint_id?: string;
	expires_in_ms?: number;
	turn?: number;
	phase?: SessionPhase;
	mode?: AgentMode;
};

// ── Extension ────────────────────────────────────────────────────────────────

export default function scratchpadExtension(pi: ExtensionAPI): void {
	const scratchpadTool: ToolDefinition<typeof scratchpadSchema> = {
		name: "scratchpad",
		label: "Scratchpad",
		description:
			"Structured session memory + task management. " +
			"Read session state, update goal/plan, add decisions, " +
			"record key learnings, manage constraints, track tasks.",
		parameters: scratchpadSchema,
		execute: async (_toolCallId: string, params: unknown, _signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> => {
			const { action, text } = params as ScratchpadToolInput;
			const pad = getOrCreateScratchpad(resolveProjectSlug(ctx.cwd));

			switch (action) {
				// ── Core ──────────────────────────────────────────────────────────

				case "read": {
					const summary = formatSessionSummary(pad);
					return {
						content: [
							{ type: "text" as const, text: formatScratchpad(pad) },
						],
						details: {
							session_summary: summary,
							key_learnings: pad.key_learnings,
							constraints: pad.constraints.filter(
								(c) => c.expires_at === 0 || c.expires_at > Date.now(),
							),
						},
					};
				}

				case "set_goal":
					if (!text) return { content: [{ type: "text" as const, text: "text required" }], details: { error: "missing_text" } };
					pad.goal = text;
					pad.session.phase = "planning";
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Goal set: ${text}` }], details: { goal: text } };

				case "add_plan":
					if (!text) return { content: [{ type: "text" as const, text: "text required" }], details: { error: "missing_text" } };
					pad.plan.push(text);
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Plan step added: ${text}` }], details: { plan: pad.plan } };

				case "mark_done":
					if (!text) return { content: [{ type: "text" as const, text: "text required" }], details: { error: "missing_text" } };
					if (!pad.done.includes(text)) pad.done.push(text);
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Marked done: ${text}` }], details: { done: pad.done } };

				case "add_decision":
					if (!text) return { content: [{ type: "text" as const, text: "text required" }], details: { error: "missing_text" } };
					pad.decisions.push(text);
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Decision recorded: ${text}` }], details: { decisions: pad.decisions } };

				case "add_hypothesis":
					if (!text) return { content: [{ type: "text" as const, text: "text required" }], details: { error: "missing_text" } };
					pad.hypotheses.push(text);
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Hypothesis added: ${text}` }], details: { hypotheses: pad.hypotheses } };

				case "add_note":
					if (!text) return { content: [{ type: "text" as const, text: "text required" }], details: { error: "missing_text" } };
					pad.notes.push(text);
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Note added: ${text}` }], details: { notes: pad.notes } };

				// ── CCA L2: Structured Session Memory ───────────────────────────────

				case "update_session": {
					const updates: string[] = [];
					if ((params as ScratchpadToolInput).turn !== undefined) {
						pad.session.turn = (params as ScratchpadToolInput).turn!;
						updates.push(`turn=${pad.session.turn}`);
					}
					if ((params as ScratchpadToolInput).phase !== undefined) {
						pad.session.phase = (params as ScratchpadToolInput).phase!;
						updates.push(`phase=${pad.session.phase}`);
					}
					if ((params as ScratchpadToolInput).mode !== undefined) {
						pad.session.mode = (params as ScratchpadToolInput).mode!;
						updates.push(`mode=${pad.session.mode}`);
					}
					if (updates.length === 0) {
						return { content: [{ type: "text" as const, text: "No session fields provided (turn, phase, mode)" }], details: { error: "no_updates" } };
					}
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Session updated: ${updates.join(", ")}` }], details: { session: pad.session } };
				}

				case "add_constraint": {
					if (!text) return { content: [{ type: "text" as const, text: "text required: \"type|description\" (e.g. \"blocker|file not found\")" }], details: { error: "missing_text" } };
					const parts = text.split("|");
					const type = (parts[0]?.trim() ?? "custom") as Constraint["type"];
					const description = parts.slice(1).join("|").trim() || text;

					const constraint: Constraint = {
						id: generateConstraintId(),
						type,
						description,
						added_at: Date.now(),
						expires_at: (params as ScratchpadToolInput).expires_in_ms ?? 0,
						acknowledged: false,
					};
					pad.constraints.push(constraint);
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Constraint added [${constraint.id}]: ${constraint.description}` }], details: { constraint } };
				}

				case "remove_constraint": {
					const cid = (params as ScratchpadToolInput).constraint_id;
					if (!cid) return { content: [{ type: "text" as const, text: "constraint_id required" }], details: { error: "missing_constraint_id" } };
					const idx = pad.constraints.findIndex((c) => c.id === cid);
					if (idx === -1) return { content: [{ type: "text" as const, text: `Constraint ${cid} not found` }], details: { error: "not_found" } };
					pad.constraints.splice(idx, 1);
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Removed constraint ${cid}` }], details: { remaining: pad.constraints.length } };
				}

				case "add_learning": {
					if (!text) return { content: [{ type: "text" as const, text: "text required: \"category|content|scope\" (e.g. \"root_cause|memory leak in pool|src/db/\")" }], details: { error: "missing_text" } };
					const parts = text.split("|");
					const category = (parts[0]?.trim() ?? "pattern") as KeyLearning["category"];
					const content = parts.slice(1).join("|").trim() || text;
					const scope = content.includes(":")
						? content.split(":").slice(0, -1).map((s) => s.trim()).filter(Boolean)
						: [];

					const learning: KeyLearning = {
						id: generateLearningId(),
						content,
						category,
						scope,
						added_at: Date.now(),
						persisted: false,
					};
					pad.key_learnings.push(learning);
					mutateAndSave(pad);
					return { content: [{ type: "text" as const, text: `Learning recorded [${learning.id}]: [${learning.category}] ${learning.content}` }], details: { learning } };
				}

				case "persist_learnings": {
					const unpersisted = pad.key_learnings.filter((l) => !l.persisted);
					if (unpersisted.length === 0) {
						return { content: [{ type: "text" as const, text: "No unpersisted learnings." }], details: { persisted: 0 } };
					}

					// Return instructions for the agent to call memory_store
					const items = unpersisted
						.map((l) => `- memory_store(content="${l.content}", memoryType="insight", tags=["${l.category}", ...])`)
						.join("\n");

					return {
						content: [
							{
								type: "text" as const,
								text: `${unpersisted.length} unpersisted learning(s). Persist them to survive compaction:\n\n${items}\n\nThese will survive context compaction.`,
							},
						],
						details: { count: unpersisted.length, learnings: unpersisted },
					};
				}

				case "note_compact": {
					// Record the compaction event
					const currentTurn = pad.session.turn;
					pad.session.last_compact_turn = currentTurn;
					mutateAndSave(pad);

					const unpersisted = pad.key_learnings.filter((l) => !l.persisted);
					if (unpersisted.length > 0) {
						// Return explicit persist instructions - the agent should call memory_store
						// before the scratchpad resets after compaction
						const items = unpersisted
							.map((l) => `memory_store(content="${l.content}", memoryType="insight", tags=["${l.category}", "session-turn-${currentTurn}"])`)
							.join("\n");

						return {
							content: [
								{
									type: "text" as const,
									text: `Context compacted at turn ${currentTurn}. ${unpersisted.length} key learning(s) not yet persisted - persist before continuing:\n\n${items}`,
								},
							],
							details: {
								compact_turn: currentTurn,
								unpersisted_count: unpersisted.length,
								message: "PERSIST_LEARNINGS_BEFORE_CONTINUING",
							},
						};
					}

					return {
						content: [{ type: "text" as const, text: `Compaction noted at turn ${currentTurn}. No unpersisted learnings.` }],
						details: { compact_turn: currentTurn },
					};
				}

				// ── Elevation ─────────────────────────────────────────────────────

				case "elevate_to_goal": {
					if (!pad.goal) return { content: [{ type: "text" as const, text: "No goal set in scratchpad. Use set_goal first." }], details: { error: "no_goal" } };
					const criteria = (params as ScratchpadToolInput).successCriteria ?? (text ? text.split(",").map((s) => s.trim()) : []);
					const priority = (params as ScratchpadToolInput).priority ?? 5;
					return {
						content: [
							{
								type: "text" as const,
								text: `Ready to elevate scratchpad goal to formal goal:\n\nGoal: ${pad.goal}\nPriority: ${priority}\nSuccess criteria: ${criteria.length > 0 ? criteria.join(", ") : "(none)"}\n\nUse: goal(action="create", description="...", successCriteria=[...], priority=${priority})`,
							},
						],
						details: { ready: true, goal: pad.goal, priority, successCriteria: criteria },
					};
				}

				case "elevate_to_plan": {
					if (pad.plan.length === 0) return { content: [{ type: "text" as const, text: "No plan steps in scratchpad. Use add_plan first." }], details: { error: "no_plan" } };
					const steps = pad.plan.map((s, i) => {
						const status = pad.done.includes(s) ? "[done]" : "[ ]";
						return `${status} ${i + 1}. ${s}`;
					});
					return {
						content: [{ type: "text" as const, text: `Ready to elevate scratchpad plan:\n\nGoal: ${pad.goal || "Untitled"}\nSteps:\n${steps.join("\n")}\n\nProvide plan details as text or I can format the steps for plan_create.` }],
						details: { ready: true, goal: pad.goal, steps: pad.plan, done: pad.done },
					};
				}

				// ── Task Management ───────────────────────────────────────────────

				case "task_add": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const task: TaskItem = {
						id: generateTaskId(),
						description: text ?? "",
						status: "pending",
						priority: (params as ScratchpadToolInput).priority ?? 0,
						dependencies: (params as ScratchpadToolInput).dependencies ?? [],
						createdAt: Date.now(),
						attempts: 0,
						maxAttempts: 3,
					};
					_taskStore.tasks.push(task);
					saveTaskStore(slug, _taskStore);
					return { content: [{ type: "text" as const, text: `Task added: ${task.id} - ${task.description}` }], details: { id: task.id, total: _taskStore.tasks.length } };
				}

				case "task_list": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					if (_taskStore.tasks.length === 0) return { content: [{ type: "text" as const, text: "No tasks." }], details: { count: 0 } };
					const lines = _taskStore.tasks.map((t) => {
						const deps = t.dependencies.length > 0 ? ` [deps: ${t.dependencies.join(", ")}]` : "";
						return `[${t.status}] ${t.id}: ${t.description}${deps}`;
					});
					return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { count: _taskStore.tasks.length, tasks: _taskStore.tasks } };
				}

				case "task_complete": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const tid = (params as ScratchpadToolInput).task_id;
					if (!tid) return { content: [{ type: "text" as const, text: "task_id required" }], details: { error: "missing_task_id" } };
					const task = _taskStore.tasks.find((t) => t.id === tid);
					if (!task) return { content: [{ type: "text" as const, text: `Task ${tid} not found` }], details: { error: "not_found" } };
					task.status = "completed";
					task.completedAt = Date.now();
					task.result = text;
					saveTaskStore(slug, _taskStore);
					return { content: [{ type: "text" as const, text: `Task ${tid} completed` }], details: { id: tid } };
				}

				case "task_fail": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const tid = (params as ScratchpadToolInput).task_id;
					if (!tid) return { content: [{ type: "text" as const, text: "task_id required" }], details: { error: "missing_task_id" } };
					const task = _taskStore.tasks.find((t) => t.id === tid);
					if (!task) return { content: [{ type: "text" as const, text: `Task ${tid} not found` }], details: { error: "not_found" } };
					task.attempts++;
					if (task.attempts >= task.maxAttempts) {
						task.status = "failed";
						task.completedAt = Date.now();
						task.error = text;
						return { content: [{ type: "text" as const, text: `Task ${tid} failed permanently (${task.attempts} attempts)` }], details: { id: tid, permanent: true } };
					}
					return { content: [{ type: "text" as const, text: `Task ${tid} failed (attempt ${task.attempts}/${task.maxAttempts})` }], details: { id: tid, willRetry: true, attempts: task.attempts } };
				}

				case "task_next": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const pending = _taskStore.tasks
						.filter((t) => t.status === "pending")
						.filter((t) => t.dependencies.every((d) => _taskStore.tasks.find((dep) => dep.id === d)?.status === "completed"))
						.sort((a, b) => b.priority - a.priority);
					if (pending.length === 0) return { content: [{ type: "text" as const, text: "No ready tasks." }], details: null };
					const next = pending[0];
					return { content: [{ type: "text" as const, text: `${next.id}: ${next.description}` }], details: { id: next.id, description: next.description, priority: next.priority } };
				}

				case "task_remove": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const tid = (params as ScratchpadToolInput).task_id;
					if (!tid) return { content: [{ type: "text" as const, text: "task_id required" }], details: { error: "missing_task_id" } };
					const idx = _taskStore.tasks.findIndex((t) => t.id === tid);
					if (idx === -1) return { content: [{ type: "text" as const, text: `Task ${tid} not found` }], details: { error: "not_found" } };
					_taskStore.tasks.splice(idx, 1);
					saveTaskStore(slug, _taskStore);
					return { content: [{ type: "text" as const, text: `Removed ${tid}` }], details: { id: tid, remaining: _taskStore.tasks.length } };
				}

				case "task_stats": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const stats = {
						total: _taskStore.tasks.length,
						pending: _taskStore.tasks.filter((t) => t.status === "pending").length,
						running: _taskStore.tasks.filter((t) => t.status === "running").length,
						completed: _taskStore.tasks.filter((t) => t.status === "completed").length,
						failed: _taskStore.tasks.filter((t) => t.status === "failed").length,
					};
					const hasWork = stats.pending > 0 || stats.running > 0;
					return {
						content: [{ type: "text" as const, text: `Tasks: ${stats.total} total (${stats.pending} pending, ${stats.running} running, ${stats.completed} done, ${stats.failed} failed)${hasWork ? " - work available" : " - no work remaining"}` }],
						details: { ...stats, hasWork },
					};
				}

				case "task_clear": {
					const slug = resolveProjectSlug();
					_taskStore = loadTaskStore(slug);
					const before = _taskStore.tasks.length;
					_taskStore.tasks = _taskStore.tasks.filter((t) => t.status === "pending" || t.status === "running");
					saveTaskStore(slug, _taskStore);
					return { content: [{ type: "text" as const, text: `Cleared ${before - _taskStore.tasks.length} completed/failed tasks` }], details: { removed: before - _taskStore.tasks.length, remaining: _taskStore.tasks.length } };
				}

				default:
					return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], details: { error: "unknown_action" } };
			}
		},
	};

	pi.registerTool({
		name: scratchpadTool.name,
		label: scratchpadTool.label,
		description: scratchpadTool.description,
		parameters: scratchpadTool.parameters,
		execute: scratchpadTool.execute,
	});

	pi.registerCommand("scratchpad-clear", {
		description: "Clear the current project scratchpad",
		handler: async (_args, ctx) => {
			const slug = resolveProjectSlug(ctx.cwd);
			_taskScratchpad = createScratchpad("", slug);
			_currentProjectSlug = slug;
			saveScratchpadToDisk(_taskScratchpad);
			ctx.ui.notify("Scratchpad cleared", "info");
		},
	});
}
