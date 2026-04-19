/**
 * Language hint module — tracks detected language for reply instructions.
 *
 * Session-scoped via ExtensionContext. All stateful functions take ctx.
 *
 * Flow:
 * 1. Preprocessor detects language → setLanguage(ctx, code, name)
 * 2. Enforcement reads on session_start → getReplyInstruction(ctx) → inject into system prompt
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getExtensionState } from "./extension-state.js";

/** State shape for language-hint */
interface LanguageHintState {
	currentLanguage: string;
	currentLanguageCode: string;
}

function getState(ctx: ExtensionContext): LanguageHintState {
	return getExtensionState(ctx, "language-hint", () => ({
		currentLanguage: "English",
		currentLanguageCode: "EN",
	}));
}

// ── Stateful API (session-scoped) ─────────────────────────────────────────────

export function setLanguage(ctx: ExtensionContext, code: string, name: string): void {
	getState(ctx).currentLanguage = name;
	getState(ctx).currentLanguageCode = code;
}

export function getLanguage(ctx: ExtensionContext): string {
	return getState(ctx).currentLanguage;
}

export function getReplyInstruction(ctx: ExtensionContext): string {
	const { currentLanguageCode, currentLanguage } = getState(ctx);
	if (currentLanguageCode === "EN") return "";
	return `\n\n### Reply Language\nRespond entirely in ${currentLanguage} unless the user writes in English.`;
}

// ── Pure API (no session state) ───────────────────────────────────────────────

/** Script-based language detection for short/unknown texts */
export function detectLanguage(text: string): { code: string; name: string } {
	if (!text || text.trim().length === 0) return { code: "EN", name: "English" };

	// Check for Cyrillic (Russian, Ukrainian, Bulgarian, etc.)
	if (/[\u0400-\u04FF]/.test(text)) return { code: "RU", name: "Russian" };

	// Check for Arabic script
	if (/[\u0600-\u06FF]/.test(text)) return { code: "AR", name: "Arabic" };

	// Check for Chinese characters
	if (/[\u4E00-\u9FFF]/.test(text)) return { code: "ZH", name: "Chinese" };

	// Check for Japanese (Hiragana + Katakana + Kanji)
	if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(text)) return { code: "JA", name: "Japanese" };

	// Check for Korean
	if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return { code: "KO", name: "Korean" };

	// Check for Devanagari (Hindi, etc.)
	if (/[\u0900-\u097F]/.test(text)) return { code: "HI", name: "Hindi" };

	// Check for Thai
	if (/[\u0E00-\u0E7F]/.test(text)) return { code: "TH", name: "Thai" };

	// Check for Hebrew
	if (/[\u0590-\u05FF]/.test(text)) return { code: "HE", name: "Hebrew" };

	// Check for Greek
	if (/[\u0370-\u03FF]/.test(text)) return { code: "EL", name: "Greek" };

	return { code: "EN", name: "English" };
}
