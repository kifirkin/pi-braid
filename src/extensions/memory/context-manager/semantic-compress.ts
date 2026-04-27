/**
 * Semantic Compression Prototype (2604.15877)
 * Compress at the semantic level — not just syntactic. Different content
 * types need different compression strategies.
 *
 * Unit Types:
 *   problem    — What we're solving. PRESERVE fully.
 *   reasoning  — How we're thinking. PRESERVE key decisions, trim intermediate.
 *   tool       — What we're doing. COLLAPSE repetitions, keep last result+count.
 *   result     — What worked. PRESERVE key outcomes.
 *   summary    — What we concluded. PRESERVE entirely.
 *   boilerplate — Noise. DROP.
 */

import type { MessageWithMetadata } from "./pruning.js";
import { createLogger } from "../../../lib/logger.js";
const log = createLogger("semantic-compress");

export type SemanticUnitType = "problem" | "reasoning" | "tool" | "result" | "summary" | "boilerplate";

export interface SemanticUnit {
	type: SemanticUnitType;
	startIndex: number;
	endIndex: number;
	messages: MessageWithMetadata[];
	preserve: boolean;
	collapse: boolean;
	priority: number; // 0=drop, 1=collapsible, 2=preservable, 3=essential
}

const UNIT_PATTERNS: Array<{ type: SemanticUnitType; patterns: RegExp[]; priority: number }> = [
	{ type: "problem", patterns: [/\bI need to\b.*\bimplement\b/i, /\bCan you\b/i, /\bPlease\b.*\bcreate\b/i, /\bHelp me\b/i, /\brequirement\b/i], priority: 3 },
	{ type: "reasoning", patterns: [/\bI think\b/i, /\bLet me\b/i, /\bPerhaps\b/i, /\bTherefore\b/i, /\bMy reasoning\b/i, /\bBased on\b/i], priority: 2 },
	{ type: "result", patterns: [/\bSuccess\b/i, /\bCompleted\b/i, /\bAll tests pass/i, /\bBuild complete/i, /\bNo errors\b/i], priority: 2 },
	{ type: "summary", patterns: [/\bIn summary\b/i, /\bTo summarize\b/i, /\bKey takeaways\b/i, /\bNext steps\b/i], priority: 3 },
	{ type: "boilerplate", patterns: [/^\s{0,10}$/, /\bSure,?\b/i, /\bOf course\b/i, /\bHere is\b.*for you\b/i, /\bLet me show you\b/i], priority: 0 },
];

export function classifyMessage(msg: MessageWithMetadata): { type: SemanticUnitType; priority: number } {
	const role = msg.message.role;
	if (role === "toolResult") {
		const isError = (msg.message as any).isError === true;
		return { type: "result", priority: 2 };
	}
	if (role === "assistant") {
		const text = extractText(msg.message);
		for (const { type, patterns, priority } of UNIT_PATTERNS) {
			if (patterns.some((p) => p.test(text))) return { type, priority };
		}
	}
	if (role === "user") return { type: "problem", priority: 3 };
	return { type: "tool", priority: 1 };
}

export function identifySemanticUnits(messages: MessageWithMetadata[]): SemanticUnit[] {
	if (messages.length === 0) return [];
	const units: SemanticUnit[] = [];
	let current: SemanticUnit | null = null;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const { type, priority } = classifyMessage(msg);

		if (!current || current.type !== type) {
			if (current) { current.endIndex = i - 1; units.push(current); }
			current = { type, startIndex: i, endIndex: i, messages: [msg], preserve: priority >= 3, collapse: priority >= 1 && priority < 3, priority };
		} else {
			current.endIndex = i;
			current.messages.push(msg);
		}
	}
	if (current) { current.endIndex = messages.length - 1; units.push(current); }
	return units;
}

function compressToolUnit(unit: SemanticUnit): MessageWithMetadata[] {
	if (unit.messages.length <= 1) return unit.messages;
	const byTool = new Map<string, MessageWithMetadata[]>();
	for (const msg of unit.messages) {
		const toolName = (msg.message as any).toolName ?? "unknown";
		if (!byTool.has(toolName)) byTool.set(toolName, []);
		byTool.get(toolName)!.push(msg);
	}
	const result: MessageWithMetadata[] = [];
	for (const [, toolMsgs] of byTool) {
		if (toolMsgs.length === 1) {
			result.push(toolMsgs[0]);
		} else {
			const last = toolMsgs[toolMsgs.length - 1];
			last.metadata.bcrCount = toolMsgs.length;
			last.metadata.bcrCollapsed = true;
			last.metadata.shouldPrune = false;
			last.metadata.pruneReason = `collapsed ${toolMsgs.length}x ${(last.message as any).toolName ?? "tool"} calls`;
			result.push(last);
		}
	}
	return result;
}

export function semanticCompress(messages: MessageWithMetadata[]): { compressed: MessageWithMetadata[]; units: SemanticUnit[]; stats: { messagesIn: number; messagesOut: number; unitsPreserved: number; unitsCollapsed: number; unitsDropped: number } } {
	if (messages.length === 0) return { compressed: [], units: [], stats: { messagesIn: 0, messagesOut: 0, unitsPreserved: 0, unitsCollapsed: 0, unitsDropped: 0 } };
	const units = identifySemanticUnits(messages);
	const compressed: MessageWithMetadata[] = [];
	let unitsPreserved = 0, unitsCollapsed = 0, unitsDropped = 0;

	for (const unit of units) {
		if (!unit.preserve && !unit.collapse) { unitsDropped++; continue; }
		let processed: MessageWithMetadata[];
		if (unit.preserve) {
			processed = unit.messages;
		} else if (unit.type === "tool") {
			processed = compressToolUnit(unit);
		} else if (unit.type === "reasoning" && unit.messages.length > 2) {
			processed = [unit.messages[0], unit.messages[unit.messages.length - 1]];
		} else if (unit.type === "boilerplate") {
			processed = (unit.messages[0].message as any).content?.toString().length > 50 ? [unit.messages[0]] : [];
		} else {
			processed = unit.messages;
		}
		if (processed.length === 0) { unitsDropped++; }
		else if (processed.length < unit.messages.length) { unitsCollapsed++; compressed.push(...processed); }
		else { unitsPreserved++; compressed.push(...processed); }
	}

	log.debug(`semantic-compress: ${messages.length}→${compressed.length} (${unitsPreserved} P, ${unitsCollapsed} C, ${unitsDropped} D)`);
	return { compressed, units, stats: { messagesIn: messages.length, messagesOut: compressed.length, unitsPreserved, unitsCollapsed, unitsDropped } };
}

function extractText(msg: any): string {
	if (!msg.content) return "";
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) return msg.content.map((c: any) => c.text ?? "").join(" ");
	return "";
}
