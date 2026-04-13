/**
 * Enforcement escalation - Escalation system for repeated violations
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { state } from "./state.js";
import type { EscalationLevel } from "./types.js";
import { sendEnforcementWhisper } from "./whisper.js";

const _ESCALATION_THRESHOLDS = { info: 1, warning: 2, critical: 3 };
const LEVEL_ORDER: EscalationLevel[] = ["info", "warning", "critical"];

export function getEscalationLevel(count: number): EscalationLevel {
	if (count >= 3) return "critical";
	if (count >= 2) return "warning";
	return "info";
}

export function getEscalationPrefix(level: EscalationLevel, label: string): string {
	if (level === "critical") return `[CRITICAL - ${label}] `;
	if (level === "warning") return `[WARNING - ${label}] `;
	return `[${label}] `;
}

export function sendEscalatedNudge(
	pi: ExtensionAPI,
	violationType: string,
	message: string,
	forceLevel?: EscalationLevel,
): { sent: boolean; level: EscalationLevel } {
	const prevCount = state.escalationCounts[violationType] || 0;
	const prevLevel = getEscalationLevel(prevCount);

	// Increment count
	state.escalationCounts[violationType] = prevCount + 1;
	const newLevel = getEscalationLevel(state.escalationCounts[violationType]);
	const targetLevel = forceLevel || newLevel;

	// Only send if escalation level changed (moved to higher level) or forced
	const prevIndex = LEVEL_ORDER.indexOf(prevLevel);
	const targetIndex = LEVEL_ORDER.indexOf(targetLevel);

	if (targetIndex > prevIndex || forceLevel) {
		const prefix = getEscalationPrefix(targetLevel, violationType.toUpperCase());
		sendEnforcementWhisper(pi, prefix + message);
		return { sent: true, level: targetLevel };
	}

	return { sent: false, level: newLevel };
}
