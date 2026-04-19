/**
 * Language hint module — tracks detected language for reply instructions.
 *
 * Flow:
 * 1. Preprocessor detects language → setLanguage(code, name)
 * 2. Enforcement reads on session_start → inject into system prompt
 */

export let currentLanguage = "English";
export let currentLanguageCode = "EN";

export function setLanguage(code: string, name: string): void {
	currentLanguage = name;
	currentLanguageCode = code;
}

export function getLanguage(): string {
	return currentLanguage;
}

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

/** Generate reply instruction for system prompt */
export function getReplyInstruction(): string {
	if (currentLanguageCode === "EN") return "";
	return `\n\n### Reply Language\nRespond entirely in ${currentLanguage} unless the user writes in English.`;
}