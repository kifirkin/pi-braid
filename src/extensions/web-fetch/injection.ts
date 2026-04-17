/**
 * Prompt injection detection via regex pattern matching.
 * Pure pattern-based - no ML dependencies. All Node.js built-ins.
 */

const PATTERN_CATEGORIES: Record<string, RegExp[]> = {
	instruction_override: [
		/ignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?|guidelines?|directions?|commands?)/i,
		/disregard\s+(all\s+)?(previous|prior|earlier|above|preceding)/i,
		/forget\s+(everything\s+)?(above|before|prior|previous|earlier)/i,
		/do\s+not\s+follow\s+(the\s+)?(previous|above|prior|earlier)/i,
		/override\s+(all\s+)?(previous|prior|earlier)/i,
		/stop\s+following\s+(your\s+)?(previous|original|initial)/i,
		/new\s+instructions?\s*[:=]/i,
		/actual\s+instructions?\s*[:=]/i,
		/real\s+instructions?\s*[:=]/i,
		/updated?\s+instructions?\s*[:=]/i,
	],
	role_injection: [
		/you\s+are\s+now\s+/i,
		/from\s+now\s+on\s*[,:]?\s*(you|your)/i,
		/act\s+as\s+(if\s+)?(you\s+)?(are\s+|were\s+)?/i,
		/pretend\s+(to\s+be|you\s+are|you're|that\s+you)/i,
		/your\s+new\s+(role|goal|purpose|instruction|directive|objective)/i,
		/imagine\s+(that\s+)?you\s+(are|were)/i,
		/roleplay\s+as/i,
		/switch\s+to\s+.{0,30}\s+mode/i,
		/you\s+must\s+now\s+(act|be|become)/i,
		/for\s+the\s+rest\s+of\s+this\s+(conversation|session|chat)/i,
	],
	system_manipulation: [
		/(admin|administrator|developer|god|sudo|root|maintenance|debug)\s+mode/i,
		/system\s+(override|prompt|instruction|message|command)/i,
		/unlock\s+(all\s+)?(restrictions?|capabilities?|features?|access)/i,
		/disable\s+(all\s+)?(safety|security|content\s+)?(filters?|guards?|restrictions?|limits?)/i,
		/bypass\s+(all\s+)?(restrictions?|filters?|safety|security|limits?)/i,
		/enable\s+(unrestricted|unlimited|full)\s+(mode|access)/i,
		/remove\s+(all\s+)?(limitations?|restrictions?|filters?)/i,
		/turn\s+off\s+(safety|security|content)?\s*(filters?|checks?|restrictions?)/i,
		/override\s+safety/i,
	],
	prompt_leak: [
		/reveal\s+(your\s+)?(system\s+)?(prompt|instructions?|directives?)/i,
		/show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions?|rules?|directives?)/i,
		/what\s+(are|is|were)\s+(your\s+)?(system\s+)?(prompt|instructions?|rules?|directives?)/i,
		/(print|display|output|echo|write|repeat)\s+(your\s+)?(system\s+)?(prompt|instructions?|directives?)/i,
		/(initial|original|hidden|secret|base)\s+(prompt|instructions?|directives?)/i,
		/(copy|paste|quote)\s+(your\s+)?(system\s+)?(prompt|instructions?)/i,
	],
	jailbreak_keywords: [
		/\bDAN\b/i,
		/jailbreak(ed|ing)?\b/i,
		/do\s+anything\s+now/i,
		/(evil|dark|shadow|unrestricted|unfiltered)\s+(mode|assistant|ai|version)/i,
		/(no|without|ignore)\s+(ethical|moral)\s+(guidelines?|restrictions?|limits?)/i,
		/hypothetically\s+(speaking|if)/i,
		/in\s+a\s+fictional\s+(scenario|world|context)/i,
		/no\s+censorship/i,
		/uncensored\s+(mode|response|version)/i,
	],
	encoding_markers: [
		/base64\s*[:=]/i,
		/decode\s+(this|the\s+following|below)/i,
		/\\x[0-9a-fA-F]{2}/,
		/&#x?[0-9a-fA-F]+;/,
		/%[0-9a-fA-F]{2}/,
		/\\u[0-9a-fA-F]{4}/,
	],
	suspicious_delimiters: [
		/\[\s*system\s*\]/i,
		/\[\s*instructions?\s*\]/i,
		/\[\s*admin\s*\]/i,
		/<\|?\s*(system|instruction|user|assistant)\s*\|?>/i,
		/###\s*(system|instruction|new\s+task)/i,
		/={3,}\s*(system|instruction|override)/i,
	],
};

export type InjectionAction = "warn" | "redact" | "tag" | "none";

export interface InjectionSpan {
	start: number;
	end: number;
}

export interface InjectionAnalysis {
	score: number;
	flagged: boolean;
	signals: string[];
	spans: InjectionSpan[];
}

function density(patterns: RegExp[], text: string, len: number): number {
	let count = 0;
	for (const p of patterns) {
		const re = new RegExp(p.source, "gi");
		const m = text.match(re);
		if (m) count += m.length;
	}
	return Math.min((count * 1000) / len, 1.0);
}

export function analyzeInjection(text: string, threshold = 0.3): InjectionAnalysis {
	const len = Math.max(text.length, 1);

	const categories: Record<string, number> = {};
	for (const [cat, patterns] of Object.entries(PATTERN_CATEGORIES)) {
		categories[cat] = density(patterns, text, len);
	}

	const active = Object.entries(categories).filter(([, v]) => v > 0);

	let score = 0;
	if (active.length > 0) {
		const weights: Record<string, number> = {
			instruction_override: 3.0,
			role_injection: 2.5,
			system_manipulation: 2.0,
			prompt_leak: 2.0,
			jailbreak_keywords: 2.5,
			encoding_markers: 1.0,
			suspicious_delimiters: 1.5,
		};
		let wSum = 0;
		let wTotal = 0;
		for (const [cat, val] of Object.entries(categories)) {
			const w = weights[cat] ?? 1;
			wSum += val * w;
			wTotal += w;
		}
		score = Math.min((wSum / wTotal) * 10, 1.0);
	}

	const flagged = score >= threshold;

	const codeMap: Record<string, string> = {
		instruction_override: "override",
		role_injection: "role",
		system_manipulation: "system",
		prompt_leak: "leak",
		jailbreak_keywords: "jailbreak",
		encoding_markers: "encoding",
		suspicious_delimiters: "delimiters",
	};
	const signals = active.map(([k]) => codeMap[k] ?? k);

	const spans: InjectionSpan[] = [];
	if (flagged) {
		const allSpans: InjectionSpan[] = [];
		for (const patterns of Object.values(PATTERN_CATEGORIES)) {
			for (const p of patterns) {
				const re = new RegExp(p.source, "gi");
				let m: RegExpExecArray | null;
				while ((m = re.exec(text)) !== null) {
					allSpans.push({ start: m.index, end: m.index + m[0].length });
				}
			}
		}
		allSpans.sort((a, b) => a.start - b.start);
		for (const s of allSpans) {
			const last = spans[spans.length - 1];
			if (last && s.start <= last.end) {
				last.end = Math.max(last.end, s.end);
			} else {
				spans.push({ ...s });
			}
		}
	}

	return { score, flagged, signals, spans };
}

export function wrapInjection(
	content: string,
	analysis: InjectionAnalysis,
	action: InjectionAction,
): string {
	let processed = content;

	if (analysis.flagged && action === "redact") {
		const REDACT = "█";
		const allSpans: InjectionSpan[] = [];
		for (const patterns of Object.values(PATTERN_CATEGORIES)) {
			for (const p of patterns) {
				const re = new RegExp(p.source, "gi");
				let m: RegExpExecArray | null;
				while ((m = re.exec(content)) !== null) {
					allSpans.push({ start: m.index, end: m.index + m[0].length });
				}
			}
		}
		allSpans.sort((a, b) => a.start - b.start);
		const merged: InjectionSpan[] = [];
		for (const s of allSpans) {
			const last = merged[merged.length - 1];
			if (last && s.start <= last.end) {
				last.end = Math.max(last.end, s.end);
			} else {
				merged.push({ ...s });
			}
		}
		const parts: string[] = [];
		let last = 0;
		for (const { start, end } of merged) {
			parts.push(processed.slice(last, start));
			parts.push(REDACT.repeat(end - start));
			last = end;
		}
		parts.push(processed.slice(last));
		processed = parts.join("");
	}

	if (analysis.flagged && action !== "none") {
		const score = analysis.score.toFixed(2);
		const sigs = analysis.signals.join(",") || "semantic";
		processed = `<suspected-prompt-injection p="${score}" t="${sigs}">\n${processed}\n</suspected-prompt-injection>`;
	}

	return `<untrusted>\n${processed}\n</untrusted>`;
}
