/**
 * Anti-Slop Input Transform Extension
 *
 * Transforms prompts to:
 * 1. Prevent code-vs-analysis confusion (original feature)
 * 2. Mark language for multilingual understanding
 * 3. Ensure reply in same language as query
 *
 * KEY DESIGN:
 * - Runs independently of user-message-preprocessor
 * - NOT disabled when preprocessor is off
 */

import type { ExtensionAPI, InputEventResult } from "@mariozechner/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════════════
// LANGUAGE DETECTION + MULTILINGUAL TRANSFORM
// ═══════════════════════════════════════════════════════════════════════════════

/** Languages with non-Latin scripts + their script ranges */
const SCRIPT_RANGES: [string, RegExp][] = [
	["Arabic", /[\u0600-\u06FF]/],
	["Chinese", /[\u4E00-\u9FFF]/],
	["Japanese", /[\u3040-\u30FF\u4E00-\u9FFF]/],
	["Korean", /[\uAC00-\uD7AF\u1100-\u11FF]/],
	["Devanagari", /[\u0900-\u097F]/],
	["Cyrillic", /[\u0400-\u04FF]/],
	["Greek", /[\u0370-\u03FF]/],
	["Hebrew", /[\u0590-\u05FF]/],
	["Thai", /[\u0E00-\u0E7F]/],
	["Tamil", /[\u0B80-\u0BFF]/],
];

/** Languages with Latin script but distinct character distributions */
const LATIN_LANGUAGE_PATTERNS: [string, RegExp][] = [
	["German", /[äöüßÄÖÜ]|ich|bin|und|ist|das|mit|ein|eine|haben|werden|sich|auf|nicht|ein|hat|von|als|auch|es|an|werden/gi],
	["French", /[àâäéèêëïîôùûüÿçœæ]|je|tu|il|elle|nous|vous|ils|elles|un|une|des|est|sont|avec|pour|dans|sur|pas|que|qui|ne|ai|as|avons|avez|ont|été|être/i],
	["Spanish", /[áéíóúüñ¿¡]|yo|tú|él|ella|nosotros|vosotros|ellos|ellas|un|una|unos|unas|es|son|está|están|con|por|para|sin|que|quien|no|he|has|hemos|habéis|han|hecho/i],
	["Portuguese", /[ãõáéíóúç]|eu|você|ele|ela|nós|vocês|eles|elas|um|uma|uns|umas|é|são|está|estão|com|por|para|que|não|tenho|tens|tem|temos|têm|feito/i],
	["Italian", /[àèéìíòóù]|io|tu|lui|lei|noi|voi|loro|un|una|uno|una|è|sono|è|stato|con|per|in|su|da|che|chi|non|ho|hai|ha|abbiamo|avete|hanno|fatto/i],
	["Polish", /[ąćęłńóśźż]|ja|ty|on|ona|my|wy|oni|one|jest|są|był|była|byli|były|mam|masz|ma|mamy|macie|mają|być|robić|robił/i],
	["Dutch", /[ij]|ik|jij|het|is|een|de|van|te|dat|ze|voor|met|niet|op|aan|maar|ook|als|bij|uit|naar|hebben|zal|worden|werd|was|zijn|geweest/i],
	["Vietnamese", /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọốồổỗộớờởỡợụủứừửữựỳýỵỹ]/i],
];

/** Detect language from text. Returns ISO code + name. */
function detectLanguage(text: string): { code: string; name: string } {
	// 1. Script-based detection (non-Latin scripts)
	for (const [name, scriptRe] of SCRIPT_RANGES) {
		if (scriptRe.test(text)) {
			const codeMap: Record<string, string> = {
				"Arabic": "AR", "Chinese": "ZH", "Japanese": "JA", "Korean": "KO",
				"Devanagari": "HI", "Cyrillic": "RU", "Greek": "EL", "Hebrew": "HE",
				"Thai": "TH", "Tamil": "TA",
			};
			return { code: codeMap[name] || name.slice(0, 2).toUpperCase(), name };
		}
	}

	// 2. Latin script — pattern-based detection
	for (const [name, pattern] of LATIN_LANGUAGE_PATTERNS) {
		const matches = text.match(pattern);
		if (matches && matches.length >= 2) {
			return { code: name.slice(0, 2).toUpperCase(), name };
		}
	}

	// 3. Default to English
	return { code: "EN", name: "English" };
}

/** Is text likely English? (for skip logic) */
function isLikelyEnglish(text: string): boolean {
	const englishWords = /\b(the|is|are|was|were|have|has|been|be|do|does|did|will|would|could|should|can|this|that|these|those|i|you|he|she|it|we|they|what|which|who|when|where|how|why|please|thanks|thank|help|write|code|function|class|variable|data|file|run|execute|start|stop|create|delete|update)\b/gi;
	const matches = text.match(englishWords);
	return (matches != null && matches.length >= 2);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODE REQUEST DETECTION (original feature - conservative patterns)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Patterns that trigger circular interpretation bug.
 * Model interprets "write function" as "analyze/animation this code".
 *
 * MUST have:
 * 1. Clear code keyword (write/create/implement)
 * 2. Language/function context nearby
 */
const CODE_REQUEST_PATTERNS = [
	/(?:^|\s)(write|create|implement)\s+(?:a\s+)?(?:javascript|js|typescript|python|function|class|code)/i,
	/(?:^|\s)(here(?:'s| is)\s+(?:a\s+)?(?:javascript|js|typescript|python|function|class|code))/i,
	/(?:^|\s)(give me (?:a\s+)?(?:javascript|js|typescript|python|function|class|code))/i,
	/(?:^|\s)(can (?:you|i) (?:get|have|write|create|implement)\s+(?:a\s+)?(?:javascript|js|typescript|python|function|class|code))/i,
];

/** Suffix appended when code request detected */
const CODE_REQUEST_SUFFIX = "\n\nOutput the code directly. Do not explain, analyze, or describe it — output only the code.";

function matchesCodeRequest(text: string): boolean {
	for (const pattern of CODE_REQUEST_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSION
// ═══════════════════════════════════════════════════════════════════════════════

let enabled = true;

export default function antiSlopExtension(pi: ExtensionAPI) {

	pi.on("input", async (event, _ctx): Promise<InputEventResult> => {
		if (!enabled) return { action: "continue" };

		const text = (event.text ?? "").trim();
		// Skip: empty, commands, or extension-injected messages
		if (!text || text.startsWith("/") || event.source === "extension") {
			return { action: "continue" };
		}

		let transformed = text;
		const lang = detectLanguage(text);
		const langNotEN = lang.code !== "EN";
		const isCode = matchesCodeRequest(text);

		// If no transform needed, continue normally
		if (!langNotEN && !isCode) {
			return { action: "continue" };
		}

		if (langNotEN) {
			// Multilingual: mark language, force reply in same language
			const langNote = `\n\n[Language: ${lang.name} (${lang.code})]\nUnderstand and reason in ${lang.name}. Provide your final reply entirely in ${lang.name}.`;
			if (isCode) {
				transformed = text + CODE_REQUEST_SUFFIX + langNote;
			} else {
				transformed = text + langNote;
			}
		} else if (isCode) {
			// English code request
			transformed = text + CODE_REQUEST_SUFFIX;
		}

		return {
			action: "transform",
			text: transformed,
		};
	});

	// ── Commands ─────────────────────────────────────────────────────────

	pi.registerCommand("anti-slop", {
		description: "Toggle anti-slop input transform",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`Anti-slop ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("anti-slop-test", {
		description: "Test anti-slop pattern detection",
		handler: async (args, ctx) => {
		const testText = typeof args === "string" ? args : Array.isArray(args) ? (args as string[]).join(" ") : String(args);
			if (!testText) {
				ctx.ui.notify("Usage: /anti-slop-test <text>", "error");
				return;
			}
			const lang = detectLanguage(testText);
			const isCode = matchesCodeRequest(testText);
			ctx.ui.notify(
				`Text: "${testText.slice(0, 40)}"\nLang: ${lang.name} (${lang.code})\nCode request: ${isCode ? "YES" : "NO"}`,
				"info"
			);
		},
	});

	pi.registerCommand("anti-slop-lang-test", {
		description: "Test language detection",
		handler: async (args, ctx) => {
			const testText = typeof args === "string" ? args : Array.isArray(args) ? (args as string[]).join(" ") : String(args);
			if (!testText) {
				ctx.ui.notify("Usage: /anti-slop-lang-test <text>", "error");
				return;
			}
			const lang = detectLanguage(testText);
			ctx.ui.notify(`Detected: ${lang.name} (${lang.code})`, "info");
		},
	});
}
