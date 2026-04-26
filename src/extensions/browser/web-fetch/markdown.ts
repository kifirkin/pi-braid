import { createLogger } from "../../../lib/logger.js";

const log = createLogger("web-fetch");
/**
 * HTML-to-markdown converter using only Node.js built-ins.
 * Strips scripts/styles, converts common elements to markdown,
 * and decodes HTML entities.
 */

// Remove script, style, and comment nodes
function stripHidden(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
}

// Convert common HTML elements to markdown equivalents
function convertElements(html: string): string {
	return html
		// Headings
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${stripTags(t).trim()}\n`)
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${stripTags(t).trim()}\n`)
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${stripTags(t).trim()}\n`)
		.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n#### ${stripTags(t).trim()}\n`)
		.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `\n##### ${stripTags(t).trim()}\n`)
		.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `\n###### ${stripTags(t).trim()}\n`)
		// Paragraphs and divs
		.replace(/<(?:p|div)[^>]*>([\s\S]*?)<\/(?:p|div)>/gi, (_, t) => `\n${stripTags(t).trim()}\n`)
		// Line breaks
		.replace(/<br\s*\/?>/gi, "\n")
		// Horizontal rules
		.replace(/<hr\s*\/?>/gi, "\n---\n")
		// Bold and italic
		.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${stripTags(t).trim()}**`)
		.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_, t) => `**${stripTags(t).trim()}**`)
		.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `*${stripTags(t).trim()}*`)
		.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_, t) => `*${stripTags(t).trim()}*`)
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${stripTags(t).trim()}\``)
		.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => `\`\`\`\n${stripTags(t).trim()}\n\`\`\`\n`)
		// Links
		.replace(
			/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
			(_, href, text) => `[${stripTags(text).trim()}](${href})`,
		)
		// Images
		.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, src, alt) => `![${alt}](${src})`)
		.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, (_, alt, src) => `![${alt}](${src})`)
		.replace(/<img[^>]*src=["']([^"']*)["'][^>]*>/gi, (_, src) => `![](${src})`)
		// Blockquotes
		.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => {
			const lines = stripTags(t).trim().split("\n");
			return lines.map((l) => `> ${l}`).join("\n") + "\n";
		})
		// Lists
		.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, t) => `\n${t}\n`)
		.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, t) => `\n${t}\n`)
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${stripTags(t).trim()}\n`)
		// Tables (basic)
		.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (m) => m + "\n")
		.replace(/<th[^>]*>([\s\S]*?)<\/th>/gi, (_, t) => `| ${stripTags(t).trim()} `)
		.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, (_, t) => `| ${stripTags(t).trim()} `)
		.replace(/<\/tr>/gi, "|\n")
		// Strip remaining tags
		.replace(/<[^>]+>/g, "");
}

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, "");
}

// Decode common HTML entities
function decodeEntities(html: string): string {
	return html
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&mdash;/g, "-")
		.replace(/&ndash;/g, "–")
		.replace(/&hellip;/g, "…")
		.replace(/&copy;/g, "©")
		.replace(/&reg;/g, "®")
		.replace(/&trade;/g, "™")
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Collapse multiple blank lines
function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToMarkdown(html: string): string {
	return collapseBlankLines(
		decodeEntities(
			convertElements(
				stripHidden(html),
			),
		),
	);
}

export function getOrigin(url: string): string {
	try {
		const u = new URL(url);
		return u.origin;
	} catch {
		return "";
	}
}
