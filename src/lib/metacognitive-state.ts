/**
 * Metacognitive State - Lightweight self-awareness for the evolve extension
 *
 * Extracted from the full Metacognition class, keeping only what's unique:
 * - Confidence tracking (0-1, adjusts on success/failure)
 * - Knowledge gaps (tracked by error type)
 * - Self-assessment recommendations
 *
 * Everything else (error patterns, metrics, retry tracking) is already
 * covered by degradation-detector and error-capture extensions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MetacognitiveState {
	confidence: number; // 0-1
	knowledgeGaps: string[];
	strengths: string[];
	weaknesses: string[];
	lastReviewAt?: number;
}

const DEFAULT_STATE: MetacognitiveState = {
	confidence: 0.8,
	knowledgeGaps: [],
	strengths: [],
	weaknesses: [],
};

let state: MetacognitiveState = { ...DEFAULT_STATE };
let storagePath: string | null = null;

export function initMetacognitiveState(storageDir?: string): void {
	state = { ...DEFAULT_STATE };
	if (storageDir) {
		storagePath = join(storageDir, "metacognitive-state.json");
		load();
	}
}

export function getMetacognitiveState(): MetacognitiveState {
	return { ...state };
}

export function adjustConfidence(delta: number): void {
	state.confidence = Math.max(0, Math.min(1, state.confidence + delta));
	state.lastReviewAt = Date.now();
	save();
}

export function recordSuccess(): void {
	adjustConfidence(0.02);
}

export function recordFailure(errorType: string): void {
	adjustConfidence(-0.1);
	if (!state.knowledgeGaps.includes(errorType)) {
		state.knowledgeGaps.push(errorType);
	}
	save();
}

export function addStrength(strength: string): void {
	if (!state.strengths.includes(strength)) {
		state.strengths.push(strength);
		state.lastReviewAt = Date.now();
		save();
	}
}

export function addWeakness(weakness: string): void {
	if (!state.weaknesses.includes(weakness)) {
		state.weaknesses.push(weakness);
		state.lastReviewAt = Date.now();
		save();
	}
}

export function resolveKnowledgeGap(gap: string): void {
	state.knowledgeGaps = state.knowledgeGaps.filter((g) => g !== gap);
	save();
}

export function shouldRequestHelp(): boolean {
	return state.confidence < 0.3;
}

export function getRecommendation(): string | null {
	if (state.confidence < 0.3) return "Low confidence - consider requesting help or switching approach";
	if (state.knowledgeGaps.length > 5) return "Many knowledge gaps - consider research or learning phase";
	if (state.weaknesses.length > 3) return "Multiple weaknesses identified - focus on addressing them";
	return null;
}

export function resetMetacognitiveState(): void {
	state = { ...DEFAULT_STATE };
	save();
}

function save(): void {
	if (!storagePath) return;
	try {
		const dir = dirname(storagePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(storagePath, JSON.stringify(state, null, 2));
	} catch { /* silent */ }
}

function load(): void {
	if (!storagePath || !existsSync(storagePath)) return;
	try {
		const loaded = JSON.parse(readFileSync(storagePath, "utf-8"));
		state = { ...DEFAULT_STATE, ...loaded };
	} catch { /* use defaults */ }
}
