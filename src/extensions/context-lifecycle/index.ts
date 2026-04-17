/**
 * Context Lifecycle Extension - S-MMU Active Context Management
 *
 * AUTOMATION layer that works WITH context-manager.
 * NO new tools - uses existing context_tag, context_compress, etc.
 *
 * R-CCAM-inspired loop:
 * - Retrieval: Signal detection from session content
 * - Cognition: Policy evaluation with governance
 * - Control: Action selection with constraint checking
 * - Action: Proposal injection or immediate execution
 * - Memory: CustomEntry persistence with outcome tracking
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { createLogger } from "../../lib/logger.js";

import type { SemanticSignal } from "./types.js";
import {
	createDefaultPolicies,
	createProposal,
	createSnapshot,
	isProposalEntry,
	isSnapshotEntry,
	PROPOSAL_CUSTOM_TYPE,
	SNAPSHOT_CUSTOM_TYPE,
	type ContextProposal,
	type ContextSnapshot,
} from "./types.js";
import { PolicyEngine, type EvaluatedAction } from "./policy-engine.js";
import { SignalDetector } from "./signal-detector.js";

// ── Module State ─────────────────────────────────────────────────────────────

const log = createLogger("context-lifecycle");

// Proposal rate limiting
const MAX_PROPOSALS_PER_TURN = 2;
const MAX_PROPOSALS_SESSION = 10;
let _proposalsThisTurn = 0;
let _proposalsTotal = 0;

const _policyEngine = new PolicyEngine();
const _signalDetector = new SignalDetector();

let _initialized = false;
let _sessionStartMs = 0;
let _turnCount = 0;

// Outcome tracking (closed-loop feedback) with TTL eviction
const MAX_OUTCOMES = 100; // Sliding window: keep last 100 outcomes
const OUTCOME_TTL_MS = 30 * 60 * 1000; // Evict after 30 minutes

const _outcomes: Array<{
	proposalId: string;
	resolution: string;
	turnsToResolve: number;
	timestamp: number;
}> = [];

/** Evict old outcomes to prevent unbounded growth */
function evictOldOutcomes(): void {
	const now = Date.now();
	const before = _outcomes.length;

	// Remove expired outcomes
	while (_outcomes.length > 0 && now - _outcomes[0].timestamp > OUTCOME_TTL_MS) {
		_outcomes.shift();
	}

	// If still over limit, remove oldest
	while (_outcomes.length > MAX_OUTCOMES) {
		_outcomes.shift();
	}

	if (_outcomes.length < before) {
		log.info(`Evicted ${before - _outcomes.length} old outcomes`);
	}
}

// Per-session proposals tracked by CustomEntry ID → proposal
const _proposalsByEntryId = new Map<string, ContextProposal>();

// ── Schema ───────────────────────────────────────────────────────────────────

const contextProposalsSchema = Type.Object({
	action: Type.Union([
		Type.Literal("list", { description: "List pending proposals" }),
		Type.Literal("approve", { description: "Approve a proposal" }),
		Type.Literal("reject", { description: "Reject/dismiss a proposal" }),
		Type.Literal("snapshots", { description: "List available snapshots" }),
		Type.Literal("stats", { description: "Show S-MMU statistics" }),
	]),
	id: Type.Optional(Type.String({ description: "Proposal ID to approve/reject" })),
});

const contextSignalSchema = Type.Object({
	type: Type.Union([
		Type.Literal("task_boundary", { description: "Mark current position as task boundary" }),
		Type.Literal("topic_shift", { description: "Mark topic shift" }),
	]),
	note: Type.Optional(Type.String({ description: "Optional note about the signal" })),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function getContextUsage(ctx: any): number {
	try {
		const usage = ctx.getContextUsage?.();
		return usage?.percent ?? 0;
	} catch {
		return 0;
	}
}

function getAllEntries(ctx: any) {
	try {
		const sm = ctx.sessionManager;
		return sm.getEntries?.() ?? [];
	} catch {
		return [];
	}
}

function getBranchEntries(ctx: any) {
	try {
		const sm = ctx.sessionManager;
		return sm.getBranch?.() ?? [];
	} catch {
		return [];
	}
}

function readProposalsFromSession(entries: any[]): ContextProposal[] {
	const proposals: ContextProposal[] = [];
	for (const entry of entries) {
		if (isProposalEntry(entry)) {
			// Use details (set via appendCustomMessageEntry's 4th param)
			const data = entry.details as ContextProposal;
			if (data && data.id && data.created_at !== undefined) {
				proposals.push(data);
				_proposalsByEntryId.set(entry.id, data);
			}
		}
	}
	return proposals;
}

function readSnapshotsFromSession(entries: any[]): ContextSnapshot[] {
	const now = Date.now();
	const snapshots: ContextSnapshot[] = [];
	for (const entry of entries) {
		if (isSnapshotEntry(entry)) {
			// appendCustomEntry uses .data field
			const data = (entry as any).data as ContextSnapshot;
			if (data && data.id && data.expires_at > now) {
				snapshots.push(data);
			}
		}
	}
	return snapshots;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
	return `${(ms / 60000).toFixed(0)}m`;
}

function interpolateMessage(message: string, ctx: any): string {
	const usage = getContextUsage(ctx);
	return message.replace("{percent}", `${usage.toFixed(0)}%`);
}

// ── Action Execution ─────────────────────────────────────────────────────────

function executeAction(evaluated: EvaluatedAction, pi: ExtensionAPI, ctx: any, usage: number, branchLength: number): void {
	const action = evaluated.action;

	switch (action.type) {
		case "compact":
			if (evaluated.canExecute) {
				ctx.compact?.();
			}
			break;

		case "snapshot":
			if (evaluated.canExecute) {
				const snapshot = createSnapshot(
					action.reason,
					branchLength,
					Math.round(usage * 2),
				);
				const sm = ctx.sessionManager;
				sm.appendCustomEntry(SNAPSHOT_CUSTOM_TYPE, snapshot);
				log.debug(`Created snapshot: ${snapshot.id}`);
			}
			break;

		case "nudge":
			if (evaluated.canExecute) {
				const msg = interpolateMessage(action.message, ctx);
				pi.sendMessage(
					{
						customType: "context-lifecycle",
						content: [{ type: "text" as const, text: msg }],
						display: false,
					},
					{ deliverAs: "steer" },
				);
			}
			break;
	}
}

function queueProposal(evaluated: EvaluatedAction, ctx: any, branchLength: number): void {
	if (evaluated.action.type !== "propose") return;

	// ── Rate limiting: prevent proposal spam ────────────────────────────────
	_proposalsThisTurn++;
	_proposalsTotal++;
	if (_proposalsThisTurn > MAX_PROPOSALS_PER_TURN) {
		log.debug(`Rate limited: ${_proposalsThisTurn} proposals this turn (max ${MAX_PROPOSALS_PER_TURN})`);
		return;
	}
	if (_proposalsTotal > MAX_PROPOSALS_SESSION) {
		log.debug(`Session limit reached: ${_proposalsTotal} proposals (max ${MAX_PROPOSALS_SESSION})`);
		return;
	}

	const action = evaluated.action;
	const existingEntries = getAllEntries(ctx);
	const existingProposals = readProposalsFromSession(existingEntries);

	// Don't duplicate recent similar proposals
	const recentSame = existingProposals.find(
		(p) =>
			p.message.includes(action.message.slice(0, 20)) &&
			Date.now() - p.created_at < 60_000,
	);
	if (recentSame) return;

	const proposal = createProposal(
		"compact",
		interpolateMessage(action.message, ctx),
		evaluated.policy.id,
		branchLength,
		action.priority,
		0.7,
	);

	const sm = ctx.sessionManager;
	sm.appendCustomMessageEntry(
		PROPOSAL_CUSTOM_TYPE,
		[
			{
				type: "text" as const,
				text: `💡 **Context Suggestion:** ${proposal.message}`,
			},
		],
		true,
		proposal,
	);
		log.debug(`Created proposal: ${proposal.id}`);
}

// ── Extension Factory ────────────────────────────────────────────────────────

export default function contextLifecycleExtension(pi: ExtensionAPI): void {
	// ── session_start ────────────────────────────────────────────────────────
	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!_initialized) {
			_initialized = true;
		}

		_sessionStartMs = Date.now();
		_turnCount = 0;
		_proposalsThisTurn = 0;
		_proposalsTotal = 0;
		_proposalsByEntryId.clear();
		_outcomes.length = 0;
		_policyEngine.resetCooldowns();
		_signalDetector.reset();
	});

	// ── before_agent_start ──────────────────────────────────────────────────
	// R-CCAM loop: Retrieval → Cognition → Control → Action
	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		_turnCount++;
		_proposalsThisTurn = 0; // Reset per-turn counter

		// Evict old outcomes on each turn (sliding window TTL)
		evictOldOutcomes();

		const usage = getContextUsage(ctx);
		const entries = getAllEntries(ctx);
		const branch = getBranchEntries(ctx);

		// ── RETRIEVAL: Detect signals from session content ──────────────────
		const signals = _signalDetector.update(entries, usage);

		// ── COGNITION: Evaluate policies against signals ───────────────────
		const redundancyCount = signals.filter((s) => s.type === "redundancy_detected").length;

		// ── TASK COMPLETION DETECTION ────────────────────────────────────────
		// Check if session looks like a completed task
		_signalDetector.checkAndEmitCompletionSignal();
		const completionSignals = _signalDetector.getPending();
		if (completionSignals.length > 0) {
			signals.push(...completionSignals);
		}

		const evaluated = _policyEngine.evaluate({
			signals,
			contextUsage: usage,
			turnCount: branch.length,
			redundancyCount,
		});

		// ── CONTROL: Validate and select actions ───────────────────────────
		for (const ev of evaluated) {
			// Log governance warnings
			if (!ev.validation.valid) {
				log.warn(`Governance blocked: ${ev.validation.messages.join(", ")}`);
			} else if (ev.validation.severity === "warn") {
				log.warn(`Governance warning: ${ev.validation.messages.join(", ")}`);
			}

			// ── ACTION: Execute or queue ───────────────────────────────────
			if (ev.action.type === "propose") {
				queueProposal(ev, ctx, branch.length);
			} else {
				executeAction(ev, pi, ctx, usage, branch.length);
			}
		}

		// ── MEMORY: Track implicit approvals ───────────────────────────────
		const proposalEntries = entries.filter(isProposalEntry);
		for (const entry of proposalEntries) {
			const proposal = entry.details as ContextProposal;
			if (proposal?.resolution) continue;

			// Mark as implicit_approved if created > 2 turns ago
			if (Date.now() - proposal.created_at > 120_000) {
				proposal.resolution = "implicit_approved";
				proposal.resolved_at = Date.now();
				_proposalsByEntryId.set(entry.id, proposal);

				// Track outcome for closed-loop feedback
				_outcomes.push({
					proposalId: proposal.id,
					resolution: "implicit_approved",
					turnsToResolve: _turnCount - proposal.turn,
					timestamp: Date.now(),
				});
			}
		}
	});

	// ── tool_call: Capture agent signals ────────────────────────────────────
	pi.on("tool_call", async (event: any) => {
		const toolName = event.toolName as string;
		const input = event.input as Record<string, unknown> | undefined;

		if (toolName === "context_tag") {
			_signalDetector.queueSignal("task_boundary", { action: "tag", target: input?.name });
		} else if (toolName === "context_compress") {
			_signalDetector.queueSignal("task_boundary", { action: "compress" });
		} else if (toolName === "context_checkout") {
			_signalDetector.queueSignal("task_boundary", { action: "checkout" });
		}
	});

	// ── Proposals Tool ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "context_proposals",
		label: "Context Proposals",
		description:
			"View and manage S-MMU context proposals. Proposals are auto-generated " +
			"based on session analysis. Use `list` to see pending, `approve`/`reject` to act.",
		parameters: contextProposalsSchema,
		execute: async (
			_toolCallId: string,
			params: any,
			_signal: any,
			_onUpdate: any,
			ctx: any,
		): Promise<any> => {
			const entries = getAllEntries(ctx);
			const proposals = readProposalsFromSession(entries);
			const pending = proposals.filter((p) => !p.resolution);
			const snapshots = readSnapshotsFromSession(entries);

			switch (params.action) {
				case "list": {
					if (pending.length === 0) {
						return {
							content: [{ type: "text" as const, text: "✓ No pending proposals." }],
							details: { pending: 0 },
						};
					}

					const lines = pending.map((p) => {
						const age = Date.now() - p.created_at;
						const icon = p.priority === "high" ? "🔴" : p.priority === "medium" ? "🟡" : "🟢";
						return `${icon} **${p.id}** (${p.priority}) ${p.message}\n  └─ ${formatDuration(age)} ago`;
					});

					return {
						content: [{
							type: "text" as const,
							text: `## Pending Proposals (${pending.length})\n\n${lines.join("\n\n")}\n\nUse context_proposals(action="approve", id="<id>") or the suggested tool.`,
						}],
						details: { pending: pending.length, proposals },
					};
				}

				case "approve": {
					const id = params.id;
					if (!id) {
						return { content: [{ type: "text" as const, text: "Proposal ID required." }], details: { error: "missing_id" } };
					}

					const proposal = pending.find((p) => p.id === id);
					if (!proposal) {
						return { content: [{ type: "text" as const, text: `Proposal ${id} not found.` }], details: { error: "not_found" } };
					}

					proposal.resolution = "approved";
					proposal.resolved_at = Date.now();
					_proposalsByEntryId.set(id, proposal);

					_outcomes.push({
						proposalId: id,
						resolution: "approved",
						turnsToResolve: _turnCount - proposal.turn,
						timestamp: Date.now(),
					});

					return {
						content: [{ type: "text" as const, text: `✓ Approved **${id}**: ${proposal.message}` }],
						details: { approved: id, proposal },
					};
				}

				case "reject": {
					const id = params.id;
					if (!id) {
						return { content: [{ type: "text" as const, text: "Proposal ID required." }], details: { error: "missing_id" } };
					}

					const proposal = pending.find((p) => p.id === id);
					if (!proposal) {
						return { content: [{ type: "text" as const, text: `Proposal ${id} not found.` }], details: { error: "not_found" } };
					}

					proposal.resolution = "rejected";
					proposal.resolved_at = Date.now();
					_proposalsByEntryId.set(id, proposal);

					_outcomes.push({
						proposalId: id,
						resolution: "rejected",
						turnsToResolve: _turnCount - proposal.turn,
						timestamp: Date.now(),
					});

					return {
						content: [{ type: "text" as const, text: `✗ Rejected **${id}**.` }],
						details: { rejected: id },
					};
				}

				case "snapshots": {
					if (snapshots.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No snapshots available." }],
							details: { count: 0 },
						};
					}

					const lines = snapshots.slice(0, 10).map((s) => {
						const expiresIn = s.expires_at - Date.now();
						return `- **${s.id}** (turn ${s.turn}) ${s.reason} | expires in ${formatDuration(expiresIn)}`;
					});

					return {
						content: [{ type: "text" as const, text: `## Snapshots (${snapshots.length})\n\n${lines.join("\n\n")}` }],
						details: { count: snapshots.length, snapshots },
					};
				}

				case "stats": {
					const policies = _policyEngine.getPolicies();
					const governance = _policyEngine.getGovernance();

					// Calculate outcome stats
					const total = _outcomes.length;
					const approved = _outcomes.filter((o) => o.resolution === "approved" || o.resolution === "implicit_approved").length;
					const avgTurns = total > 0
						? _outcomes.reduce((sum, o) => sum + o.turnsToResolve, 0) / total
						: 0;

					return {
						content: [{
							type: "text" as const,
							text: [
								"## S-MMU Statistics",
								`**Session:** ${_turnCount} turns | ${formatDuration(Date.now() - _sessionStartMs)}`,
								`**Proposals:** ${pending.length} pending, ${proposals.filter((p) => p.resolution).length} resolved`,
								`**Outcomes:** ${approved}/${total} approved (${avgTurns.toFixed(1)} turns avg)`,
								`**Policies:** ${policies.length} active`,
								`**Governance:** ${governance.length} constraints`,
								"",
								"### Topic History",
								..._signalDetector.getTopicHistory().slice(-5).map((h) => `- Turn ${h.turn}: ${h.topic}`),
							].join("\n"),
						}],
						details: {
							turns: _turnCount,
							proposals,
							outcomes: _outcomes,
							policies,
							governance,
							topicHistory: _signalDetector.getTopicHistory(),
						},
					};
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
						details: { error: "unknown_action" },
					};
			}
		},
	});

	// ── context_signal: Manual semantic signals ────────────────────────────────
	pi.registerTool({
		name: "context_signal",
		label: "Context Signal",
		description: "Emit a semantic signal to the S-MMU policy engine.",
		parameters: contextSignalSchema,
		execute: async (
			_toolCallId: string,
			params: any,
			_signal: any,
			_onUpdate: any,
			_ctx: any,
		): Promise<any> => {
			const type = params.type;
			const note = params.note ?? "";

			_signalDetector.queueSignal(type, { note, turn: _turnCount });

			return {
				content: [{ type: "text" as const, text: `✓ Signal emitted: ${type}${note ? ` - ${note}` : ""}` }],
				details: { signal: type, note },
			};
		},
	});
}
